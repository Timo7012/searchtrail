import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App as ObsidianApp } from 'obsidian';
import { App } from './obsidian-mock';
import { addRun, addStrategy, createProject, editProject, getStats, lastRevision } from '../src/model';
import { addMaterial, editMaterial, emptyCatalog, emptyMaterial, materialInput, parseMaterialCatalog, validateMaterialPath } from '../src/materials';
import { catalogFingerprint, createProjectDocument, projectFingerprint, readMaterialCatalog, readProjectDocument, updateMaterialCatalogDocument, updateProjectDocument } from '../src/storage';
import { ProjectRepository } from '../src/repository';
import { parseProjectTransfer, projectTransferToJson } from '../src/transfer';
import { materialsToCsv, materialsToMarkdown } from '../src/material-exports';

const projectInput = { title: 'Рабочий поиск', question: '', criteria: '', deduplicationNotes: '' };
const project = () => createProject(projectInput);
function linkedProject() {
  const p = addStrategy(project(), { title: 'Документация', status: 'active', changeNote: '', definition: { database: 'Docs', platform: 'Web', query: 'device guide', searchFields: '', filters: '', publicationRange: '', languages: '', searchUrl: '' } });
  const strategy = p.strategies[0];
  return addRun(p, strategy.id, lastRevision(strategy).id, { purpose: 'main', status: 'completed', executedAt: '2026-11-12', timeZone: '', reportedHits: null, reportedHitsApproximate: false, screenedRecords: 0, selectedRecords: 0, exportedRecords: null, durationMinutes: null, resultUrl: '', exportPath: '', zoteroLink: '', notes: '' });
}

test('materials require only a title and preserve unknown bibliography without inventing values', () => {
  const p = project(), before = JSON.stringify(p);
  const catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: '  Инструкция оборудования  ' });
  assert.equal(catalog.materials[0].title, 'Инструкция оборудования');
  assert.equal(catalog.materials[0].doi, '');
  assert.equal(catalog.materials[0].year, null);
  assert.equal(catalog.materials[0].authors, '');
  assert.deepEqual(parseMaterialCatalog(catalog, p), catalog);
  assert.equal(JSON.stringify(p), before);
});

test('one material links to several searches and edits preserve identity and history without changing counters', () => {
  const p = linkedProject();
  const before = getStats(p);
  let catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'Guide', kind: 'documentation', strategyIds: [p.strategies[0].id], runIds: [p.runs[0].id] });
  const original = structuredClone(catalog.materials[0]);
  catalog = editMaterial(catalog, p, original.id, { ...materialInput(original), readingStatus: 'read', decision: 'excluded', exclusionReason: 'Другая модель устройства' });
  assert.equal(catalog.materials.length, 1);
  assert.equal(catalog.materials[0].createdAt, original.createdAt);
  assert.deepEqual(catalog.materials[0].history[0].previous, (({ history, ...body }) => body)(original));
  assert.deepEqual(getStats(p), before);
  assert.deepEqual(parseMaterialCatalog(catalog, p), catalog);
});

test('invalid optional fields, links, exclusions and executable URLs are refused', () => {
  const p = linkedProject();
  for (const input of [
    { ...emptyMaterial(), title: '' }, { ...emptyMaterial(), title: 'X', year: 0 },
    { ...emptyMaterial(), title: 'X', year: 2026.5 }, { ...emptyMaterial(), title: 'X', doi: 'invented' },
    { ...emptyMaterial(), title: 'X', url: 'javascript:alert(1)' },
    { ...emptyMaterial(), title: 'X', filePath: '../secret.md' },
    { ...emptyMaterial(), title: 'X', notePath: '.obsidian/data.json' },
    { ...emptyMaterial(), title: 'X', kind: ['article'] },
    { ...emptyMaterial(), title: 'X', decision: 'excluded', exclusionReason: '' },
    { ...emptyMaterial(), title: 'X', strategyIds: ['unknown'] },
    { ...emptyMaterial(), title: 'X', runIds: [p.runs[0].id, p.runs[0].id] },
    { ...emptyMaterial(), title: 'X', future: 'keep me' },
  ]) assert.throws(() => addMaterial(emptyCatalog(p.id), p, input as never));
  assert.doesNotThrow(() => addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'Article', doi: '10.1234/example', year: 2020 }));
});

test('catalog parsers reject future data, wrong project identity, duplicate IDs and foreign history', () => {
  const p = project(), catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'Guide' });
  for (const value of [
    { ...catalog, schemaVersion: 2 }, { ...catalog, projectId: 'another' },
    { ...catalog, future: 'keep' }, { ...catalog, materials: [...catalog.materials, ...catalog.materials] },
    { ...catalog, revision: 0 },
  ]) assert.throws(() => parseMaterialCatalog(value, p));
  const changed = editMaterial(catalog, p, catalog.materials[0].id, { ...materialInput(catalog.materials[0]), notes: 'New' });
  changed.materials[0].history[0].previous.id = 'foreign';
  assert.throws(() => parseMaterialCatalog(changed, p), /другому/);
});

test('new managed catalog leaves project v1, its fingerprint and user text unchanged', () => {
  const p = project(), catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'Guide' });
  const manual = '\n## Пользовательский текст\nНе менять.\n';
  const text = createProjectDocument(p) + manual;
  const updated = updateMaterialCatalogDocument(text, catalog, p.revision, projectFingerprint(p), null);
  assert.deepEqual(readProjectDocument(updated), p);
  assert.deepEqual(readMaterialCatalog(updated, p), catalog);
  assert.ok(updated.includes(manual));
  const edited = editProject(p, { ...projectInput, question: 'Новая задача' });
  const next = updateProjectDocument(updated, edited, p.revision, projectFingerprint(p));
  assert.deepEqual(readMaterialCatalog(next, edited), catalog);
  assert.ok(next.includes(manual));
});

test('catalog conflicts detect concurrent edits and same-revision external changes', () => {
  const p = project();
  const catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'One' });
  const text = createProjectDocument(p, catalog);
  const changed = editMaterial(catalog, p, catalog.materials[0].id, { ...materialInput(catalog.materials[0]), title: 'Two' });
  assert.throws(() => updateMaterialCatalogDocument(text, changed, p.revision, projectFingerprint(p), null), /изменены/);
  const external = text.replace('"title": "One"', '"title": "External"');
  assert.throws(() => updateMaterialCatalogDocument(external, changed, p.revision, projectFingerprint(p), catalogFingerprint(catalog)), /изменены/);
  assert.throws(() => updateMaterialCatalogDocument(text, changed, p.revision + 1, projectFingerprint(p), catalogFingerprint(catalog)), /изменены/);
});

test('corrupt and overlapping material blocks cannot be silently removed by saving a project', () => {
  const p = project(), catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'One' });
  const text = createProjectDocument(p, catalog);
  const marker = '<!-- research-search:materials:start -->';
  for (const damaged of [
    text + '\n' + marker, text.replace('<!-- research-search:materials:end -->', ''),
    text.replace('"schemaVersion": 1,\n  "projectId"', '"schemaVersion": 9,\n  "projectId"'),
    text.replace('<!-- research-search:materials-report:end -->', '').replace(marker, '<!-- research-search:materials-report:end -->\n' + marker).replace('<!-- research-search:materials:end -->', '<!-- research-search:materials:end -->\n<!-- research-search:materials-report:start -->'),
  ]) assert.throws(() => updateProjectDocument(damaged, editProject(p, projectInput), p.revision, projectFingerprint(p)));
});

test('Unicode markers and hostile Markdown in material text round-trip without creating structural blocks', () => {
  const p = project();
  const title = '<script>alert(1)</script>\n<!-- research-search:materials:end -->\u2028<!-- research-search:data:start -->';
  const catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title, notes: '```\n<img src=x onerror=alert(1)>\n```' });
  const text = createProjectDocument(p, catalog);
  assert.deepEqual(readMaterialCatalog(text, p), catalog);
  const report = materialsToMarkdown(catalog);
  assert.ok(!report.includes('<script>'));
  assert.ok(report.includes('````text'));
});

test('full JSON transfer preserves catalog IDs, links and history and still accepts legacy project JSON', () => {
  const p = linkedProject();
  let catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: 'One', runIds: [p.runs[0].id] });
  catalog = editMaterial(catalog, p, catalog.materials[0].id, { ...materialInput(catalog.materials[0]), notes: 'Changed' });
  assert.deepEqual(parseProjectTransfer(JSON.parse(projectTransferToJson(p, catalog))), { project: p, catalog });
  assert.deepEqual(JSON.parse(projectTransferToJson(p)), p);
  assert.deepEqual(parseProjectTransfer(p), { project: p });
  assert.throws(() => parseProjectTransfer({ format: 'searchtrail-project', transferVersion: 2, project: p, catalog }));
  assert.throws(() => parseProjectTransfer({ format: 'searchtrail-project', transferVersion: 1, project: p, catalog, future: 'keep' }));
});

test('materials CSV retains safe formula escaping and distinguishes null year from supplied year', () => {
  const p = project();
  const catalog = addMaterial(emptyCatalog(p.id), p, { ...emptyMaterial(), title: '=HYPERLINK("evil")', notes: '@formula\nnext' });
  const csv = materialsToCsv(catalog);
  assert.ok(csv.includes("\"'=HYPERLINK"));
  assert.ok(csv.includes("\"'@formula\nnext\""));
  assert.ok(!csv.includes('"null"'));
});

function setup() {
  const app = new App();
  let folder = 'Search Strategies';
  const repository = new ProjectRepository(app as unknown as ObsidianApp, () => folder, () => {});
  return { app, repository, setFolder: (value: string) => { folder = value; } };
}

test('repository saves catalog with conflicts, preserves it on project edits and transfers it to another folder', async () => {
  const { app, repository, setFolder } = setup();
  const entry = await repository.create(projectInput);
  const catalog = addMaterial(emptyCatalog(entry.project.id), entry.project, { ...emptyMaterial(), title: 'One' });
  const saved = await repository.saveMaterials(entry, catalog);
  assert.deepEqual(saved.project, entry.project);
  assert.deepEqual((await repository.listProjects())[0].catalog, catalog);
  await assert.rejects(repository.saveMaterials(entry, catalog), /изменены/);
  const edited = await repository.save(entry.path, entry.project.revision, editProject(entry.project, { ...projectInput, title: 'Changed' }), entry.fingerprint);
  assert.deepEqual(edited.catalog, catalog);
  const jsonPath = await repository.export(edited, 'json');
  const bundle = JSON.parse(app.vault.contents.get(jsonPath)!);
  const csvPath = await repository.export(edited, 'materials-csv');
  assert.ok(csvPath.endsWith('.csv'));
  assert.ok(app.vault.contents.get(csvPath)!.includes('material_id'));
  const mdPath = await repository.export(edited, 'markdown');
  assert.ok(app.vault.contents.get(mdPath)!.includes('Материалы проекта'));
  setFolder('Imported');
  const imported = await repository.importProject(bundle);
  assert.deepEqual(imported.catalog, catalog);
  assert.deepEqual(imported.project, edited.project);
  await assert.rejects(repository.importProject(bundle), /ID/);
});

test('repository serializes concurrent initial catalog saves so only one succeeds', async () => {
  const { repository } = setup();
  const entry = await repository.create(projectInput);
  const one = addMaterial(emptyCatalog(entry.project.id), entry.project, { ...emptyMaterial(), title: 'One' });
  const two = addMaterial(emptyCatalog(entry.project.id), entry.project, { ...emptyMaterial(), title: 'Two' });
  const results = await Promise.allSettled([repository.saveMaterials(entry, one), repository.saveMaterials(entry, two)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal((await repository.listProjects())[0].catalog!.materials.length, 1);
});

test('material paths reject config directories and folder switches prevent misplaced writes', async () => {
  const { app, repository, setFolder } = setup();
  app.vault.configDir = 'Config';
  for (const path of ['Config/token.json', 'config\\token.json', '/outside.pdf', 'C:\\outside.pdf', '../outside.pdf']) assert.throws(() => validateMaterialPath(path, 'Config'));
  const entry = await repository.create(projectInput);
  const catalog = addMaterial(emptyCatalog(entry.project.id), entry.project, { ...emptyMaterial(), title: 'One', filePath: 'Config/token.json' });
  await assert.rejects(repository.saveMaterials(entry, catalog), /конфигурации/);
  const clean = addMaterial(emptyCatalog(entry.project.id), entry.project, { ...emptyMaterial(), title: 'One' });
  const before = app.vault.contents.get(entry.path);
  setFolder('Other');
  await assert.rejects(repository.saveMaterials(entry, clean), /Папка/);
  assert.equal(app.vault.contents.get(entry.path), before);
});
