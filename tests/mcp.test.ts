import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App as ObsidianApp } from 'obsidian';
import type { McpToolDefinition, McpToolResult } from 'obsidian-local-rest-api';
import { App } from './obsidian-mock';
import { ProjectRepository } from '../src/repository';
import { createSearchTrailTools, SearchTrailMcp, type McpExtensionApi, type McpHost } from '../src/mcp';
import { createProjectDocument, readProjectDocument } from '../src/storage';
import type { ProjectEntry } from '../src/contracts';
import type { RunInput, StrategyInput } from '../src/model';
import { materialInput } from '../src/materials';

const projectInput = { title: 'MCP test', question: 'Question', criteria: '', deduplicationNotes: '' };
const strategy: StrategyInput = {
  title: 'Query', status: 'active', changeNote: 'Initial', definition: {
    database: 'Test source', platform: 'Test platform', query: 'one\nAND two',
    searchFields: '', filters: '', publicationRange: '', languages: '', searchUrl: '',
  },
};
const run: RunInput = {
  purpose: 'pilot', status: 'partial', executedAt: '2026-11-12', timeZone: '',
  reportedHits: null, reportedHitsApproximate: false, screenedRecords: 0,
  selectedRecords: 0, exportedRecords: null, durationMinutes: null,
  resultUrl: '', exportPath: '', zoteroLink: '', notes: '',
};
const guard = (entry: ProjectEntry) => ({
  projectId: entry.project.id, expectedRevision: entry.project.revision, expectedFingerprint: entry.fingerprint,
});

function data<T>(result: McpToolResult): T {
  assert.ok(!result.isError, JSON.stringify(result.content));
  const content = result.content[0];
  assert.equal(content.type, 'text');
  return JSON.parse((content as { text: string }).text) as T;
}

function setup() {
  const app = new App();
  let folder = 'Search Strategies';
  const repository = new ProjectRepository(app as unknown as ObsidianApp, () => folder, () => {});
  const host: McpHost = {
    listProjects: () => repository.listProjects(),
    createProject: input => repository.create(input),
    saveProject: (...args) => repository.save(...args),
    importProject: value => repository.importProject(value),
    exportProject: (...args) => repository.export(...args),
    saveMaterials: (...args) => repository.saveMaterials(...args),
  };
  const definitions = createSearchTrailTools(host);
  const call = (name: string, args: Record<string, unknown> = {}) => definitions.find(tool => tool.name === `searchtrail_${name}`)!.callback(args);
  return { app, repository, host, call, setFolder: (value: string) => { folder = value; } };
}

test('MCP workflow preserves query versions, null/zero, date precision and correction history', async () => {
  const { call } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  entry = data<ProjectEntry>(await call('add_strategy', { ...guard(entry), input: strategy }));
  const strategyId = entry.project.strategies[0].id;
  const queryRevisionId = entry.project.strategies[0].revisions[0].id;
  entry = data<ProjectEntry>(await call('edit_strategy', {
    ...guard(entry), strategyId, input: { ...strategy, definition: { ...strategy.definition, query: 'new query' } },
  }));
  entry = data<ProjectEntry>(await call('add_run', { ...guard(entry), strategyId, queryRevisionId, input: run }));
  assert.equal(entry.project.runs[0].definition.query, strategy.definition.query);
  assert.equal(entry.project.runs[0].queryRevisionNumber, 1);
  assert.equal(entry.project.runs[0].executedAt, '2026-11-12');
  assert.equal(entry.project.runs[0].reportedHits, null);
  assert.equal(entry.project.runs[0].screenedRecords, 0);
  const before = structuredClone(entry.project.runs[0]);
  entry = data<ProjectEntry>(await call('correct_run', { ...guard(entry), runId: before.id, reason: 'Checked count', input: { ...run, reportedHits: 10 } }));
  assert.equal(entry.project.runs[0].reportedHits, 10);
  assert.equal(entry.project.runs[0].history[0].previous.reportedHits, null);
  assert.equal(entry.project.runs[0].history[0].reason, 'Checked count');
  assert.equal(entry.project.runs[0].recordedAt, before.recordedAt);
  assert.deepEqual(entry.project.runs[0].definition, before.definition);
});

test('MCP stale revision and same-revision external changes are refused without writes', async () => {
  const { call, app } = setup();
  const original = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  const updated = data<ProjectEntry>(await call('edit_project', { ...guard(original), input: { ...projectInput, title: 'Updated' } }));
  const before = app.vault.contents.get(original.path);
  assert.equal((await call('add_strategy', { ...guard(original), input: strategy })).isError, true);
  assert.equal(app.vault.contents.get(original.path), before);
  app.vault.externalWrite(original.path, before!.replace('"question": "Question"', '"question": "External"'));
  const external = app.vault.contents.get(original.path);
  assert.equal((await call('edit_project', { ...guard(updated), input: projectInput })).isError, true);
  assert.equal(app.vault.contents.get(original.path), external);
});

test('MCP simultaneous edits commit only once and preserve notes outside managed blocks', async () => {
  const { call, app } = setup();
  const entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  const note = '\n## Manual note\nKeep me exactly.\n';
  app.vault.externalWrite(entry.path, app.vault.contents.get(entry.path)! + note);
  const results = await Promise.all([
    call('add_strategy', { ...guard(entry), input: strategy }),
    call('edit_project', { ...guard(entry), input: { ...projectInput, title: 'Concurrent' } }),
  ]);
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.equal(results.filter(result => result.isError).length, 1);
  const saved = app.vault.contents.get(entry.path)!;
  assert.ok(saved.endsWith(note));
  assert.equal(readProjectDocument(saved).revision, 2);
});

test('MCP checks fingerprint again when data changes between lookup and Vault.process', async () => {
  const { call, app, host } = setup();
  const entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  const save = host.saveProject;
  host.saveProject = async (...args) => {
    app.vault.externalWrite(entry.path, app.vault.contents.get(entry.path)!.replace('"question": "Question"', '"question": "Raced"'));
    return save(...args);
  };
  assert.equal((await call('edit_project', { ...guard(entry), input: projectInput })).isError, true);
  assert.equal(readProjectDocument(app.vault.contents.get(entry.path)!).question, 'Raced');
});

test('MCP refuses invalid fields, missing preconditions and immutable snapshot overrides', async () => {
  const { call, app } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  assert.equal((await call('edit_project', { projectId: entry.project.id, input: projectInput })).isError, true);
  assert.equal((await call('add_strategy', { ...guard(entry), input: { ...strategy, surprise: true } })).isError, true);
  entry = data<ProjectEntry>(await call('add_strategy', { ...guard(entry), input: strategy }));
  const strategyId = entry.project.strategies[0].id;
  const queryRevisionId = entry.project.strategies[0].revisions[0].id;
  const before = app.vault.contents.get(entry.path);
  for (const input of [
    { ...run, reportedHits: -1 }, { ...run, reportedHits: '0' },
    { ...run, selectedRecords: 1 }, { ...run, executedAt: '2026-02-30' },
    { ...run, definition: strategy.definition }, { ...run, history: [] },
  ]) {
    assert.equal((await call('add_run', { ...guard(entry), strategyId, queryRevisionId, input })).isError, true);
    assert.equal(app.vault.contents.get(entry.path), before);
  }
  entry = data<ProjectEntry>(await call('add_run', { ...guard(entry), strategyId, queryRevisionId, input: run }));
  assert.equal((await call('correct_run', { ...guard(entry), runId: entry.project.runs[0].id, reason: ' ', input: run })).isError, true);
  assert.equal((await call('add_run', { ...guard(entry), strategyId, queryRevisionId: 'missing', input: run })).isError, true);
});

test('MCP never selects a duplicate ID and refuses writes after a data-folder switch', async () => {
  const { call, app, setFolder } = setup();
  const entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  await app.vault.create('Search Strategies/duplicate.md', createProjectDocument(entry.project));
  assert.equal((await call('get_project', { projectId: entry.project.id })).isError, true);
  const before = [...app.vault.contents];
  assert.equal((await call('edit_project', { ...guard(entry), input: projectInput })).isError, true);
  setFolder('Other');
  assert.equal((await call('edit_project', { ...guard(entry), input: projectInput })).isError, true);
  assert.deepEqual([...app.vault.contents], before);
});

test('MCP exports round-trip full data and preserve earlier exports; duplicate and future imports fail', async () => {
  const { call, app, setFolder } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  entry = data<ProjectEntry>(await call('add_strategy', { ...guard(entry), input: strategy }));
  entry = data<ProjectEntry>(await call('add_run', { ...guard(entry), strategyId: entry.project.strategies[0].id, queryRevisionId: entry.project.strategies[0].revisions[0].id, input: run }));
  entry = data<ProjectEntry>(await call('correct_run', { ...guard(entry), runId: entry.project.runs[0].id, reason: 'Test correction', input: { ...run, notes: 'Corrected' } }));
  const first = data<{ path: string }>(await call('export_project', { projectId: entry.project.id, format: 'json' }));
  const original = app.vault.contents.get(first.path)!;
  const second = data<{ path: string }>(await call('export_project', { projectId: entry.project.id, format: 'json' }));
  assert.notEqual(first.path, second.path);
  assert.equal(app.vault.contents.get(first.path), original);
  assert.deepEqual(JSON.parse(original), entry.project);
  assert.equal((await call('import_project', { project: entry.project })).isError, true);
  assert.equal((await call('import_project', { project: { ...entry.project, schemaVersion: 2 } })).isError, true);
  setFolder('Imported');
  const imported = data<ProjectEntry>(await call('import_project', { project: JSON.parse(original) }));
  assert.deepEqual(imported.project, entry.project);
  assert.equal((await call('import_project', { project: entry.project })).isError, true);
  for (const format of ['csv', 'markdown']) {
    const exported = data<{ path: string }>(await call('export_project', { projectId: entry.project.id, format }));
    assert.ok(app.vault.contents.get(exported.path));
  }
});

test('MCP listing is bounded and statistics include known-value coverage', async () => {
  const { call } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  await call('create_project', { input: { ...projectInput, title: 'Second' } });
  const page = data<{ total: number; projects: unknown[]; nextOffset: number }>(await call('list_projects', { limit: 1 }));
  assert.equal(page.total, 2);
  assert.equal(page.projects.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal((await call('list_projects', { limit: 101 })).isError, true);
  entry = data<ProjectEntry>(await call('add_strategy', { ...guard(entry), input: strategy }));
  entry = data<ProjectEntry>(await call('add_run', { ...guard(entry), strategyId: entry.project.strategies[0].id, queryRevisionId: entry.project.strategies[0].revisions[0].id, input: run }));
  const stats = data<{ scope: string; stats: { totals: { reportedHits: unknown; screenedRecords: unknown } } }>(await call('get_stats', { projectId: entry.project.id }));
  assert.equal(stats.scope, 'all_project_runs');
  assert.deepEqual(stats.stats.totals.reportedHits, { sum: 0, known: 0, total: 1 });
  assert.deepEqual(stats.stats.totals.screenedRecords, { sum: 0, known: 1, total: 1 });
});

function fakeApi(version = 3) {
  const tools: McpToolDefinition[] = [];
  let removals = 0;
  const api: McpExtensionApi = {
    apiVersion: version,
    addMcpTool: ((definition: McpToolDefinition) => { tools.push(definition); }) as McpExtensionApi['addMcpTool'],
    unregister: () => { removals++; },
  };
  return { api, tools, get removals() { return removals; } };
}

test('MCP lifecycle handles absent host, late load, host reload and SearchTrail unload', async () => {
  const { host, app } = setup();
  const first = fakeApi(), second = fakeApi();
  let available: McpExtensionApi | undefined;
  const integration = new SearchTrailMcp(host, () => available);
  integration.connect();
  assert.match(integration.status, /не загружен/);
  available = first.api;
  integration.connect();
  assert.equal(first.tools.length, 14);
  assert.ok(first.tools.filter(t => ['searchtrail_list_projects', 'searchtrail_get_project', 'searchtrail_get_stats'].includes(t.name)).every(t => t.annotations?.readOnlyHint));
  available = second.api;
  integration.connect();
  assert.equal(first.removals, 1);
  assert.equal(second.tools.length, 14);
  const staleCreate = first.tools.find(t => t.name === 'searchtrail_create_project')!;
  assert.equal((await staleCreate.callback({ input: projectInput })).isError, true);
  const create = second.tools.find(t => t.name === 'searchtrail_create_project')!;
  data<ProjectEntry>(await create.callback({ input: projectInput }));
  integration.disconnect();
  assert.equal(second.removals, 1);
  assert.equal((await create.callback({ input: projectInput })).isError, true);
  assert.equal(app.vault.createdPaths.length, 1);
});

test('MCP registration failure rolls back partial tools and leaves normal project operations available', async () => {
  const { host } = setup();
  const api = fakeApi();
  let attempt = 0;
  api.api.addMcpTool = (() => { if (++attempt === 3) throw new Error('Registration failed'); }) as McpExtensionApi['addMcpTool'];
  const integration = new SearchTrailMcp(host, () => api.api);
  const original = console.error;
  console.error = () => {};
  try { integration.connect(); } finally { console.error = original; }
  assert.equal(api.removals, 1);
  assert.match(integration.status, /Registration failed/);
  await host.createProject(projectInput);
  assert.equal((await host.listProjects()).length, 1);
});

test('MCP older host is rejected and its handle released', () => {
  const { host } = setup();
  const api = fakeApi(2);
  const integration = new SearchTrailMcp(host, () => api.api);
  const original = console.error;
  console.error = () => {};
  try { integration.connect(); } finally { console.error = original; }
  assert.equal(api.tools.length, 0);
  assert.equal(api.removals, 1);
  assert.match(integration.status, /версии 3/);
});

test('MCP materials allow title-only creation, require complete edits and reject stale catalog tokens', async () => {
  const { call } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  const original = structuredClone(entry.project);
  entry = data<ProjectEntry>(await call('add_material', { ...guard(entry), expectedCatalogFingerprint: null, input: { title: 'Рабочая инструкция' } }));
  assert.deepEqual(entry.project, original);
  const material = entry.catalog!.materials[0];
  assert.equal(material.doi, '');
  assert.equal(material.year, null);
  const token = entry.catalogFingerprint;
  assert.equal((await call('edit_material', { ...guard(entry), expectedCatalogFingerprint: token, materialId: material.id, input: { title: 'Partial edit' } })).isError, true);
  entry = data<ProjectEntry>(await call('edit_material', { ...guard(entry), expectedCatalogFingerprint: token, materialId: material.id, input: { ...materialInput(material), readingStatus: 'read', decision: 'selected' } }));
  assert.equal(entry.catalog!.materials[0].history.length, 1);
  assert.equal((await call('add_material', { ...guard(entry), expectedCatalogFingerprint: token, input: { title: 'Stale write' } })).isError, true);
  const list = data<{ total: number }>(await call('list_materials', { projectId: entry.project.id }));
  assert.equal(list.total, 1);
  entry = data<ProjectEntry>(await call('edit_project', { ...guard(entry), input: { ...projectInput, title: 'Renamed' } }));
  assert.equal(entry.catalog!.materials[0].title, 'Рабочая инструкция');
});

test('MCP transfers material catalogs through JSON while retaining import collision protection', async () => {
  const { call, app, setFolder } = setup();
  let entry = data<ProjectEntry>(await call('create_project', { input: projectInput }));
  entry = data<ProjectEntry>(await call('add_material', { ...guard(entry), expectedCatalogFingerprint: null, input: { title: 'Документ без DOI', kind: 'documentation' } }));
  const json = data<{ path: string }>(await call('export_project', { projectId: entry.project.id, format: 'json' }));
  const bundle = JSON.parse(app.vault.contents.get(json.path)!);
  assert.equal(bundle.project.schemaVersion, 1);
  assert.deepEqual(bundle.catalog, entry.catalog);
  const csv = data<{ path: string }>(await call('export_project', { projectId: entry.project.id, format: 'materials-csv' }));
  assert.ok(app.vault.contents.get(csv.path)!.includes('material_id'));
  setFolder('Imported');
  const imported = data<ProjectEntry>(await call('import_project', { project: bundle }));
  assert.deepEqual(imported.catalog, entry.catalog);
  assert.equal((await call('import_project', { project: bundle })).isError, true);
});
