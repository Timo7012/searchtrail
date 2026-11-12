import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App as ObsidianApp } from 'obsidian';
import { App, TFile } from './obsidian-mock';
import { ProjectRepository, validateDataFolder } from '../src/repository';
import { createProject, editProject, type ProjectInput } from '../src/model';
import { createProjectDocument, readProjectDocument } from '../src/storage';

const input: ProjectInput = { title: 'Search project', question: 'Original question', criteria: 'Articles', deduplicationNotes: '' };

function setup() {
  const app = new App();
  let folder = 'Search Strategies';
  const warnings: string[] = [];
  const repository = new ProjectRepository(app as unknown as ObsidianApp, () => folder, warning => warnings.push(warning));
  return { app, repository, warnings, setFolder: (next: string) => { folder = next; } };
}

test('repository creates a project note and returns the same validated project on reload', async () => {
  const { app, repository } = setup();
  const created = await repository.create(input);
  assert.ok(created.path.startsWith('Search Strategies/search-'));
  assert.equal(app.vault.createdPaths.length, 1);
  const listed = await repository.listProjects();
  assert.deepEqual(listed, [created]);
  assert.deepEqual(readProjectDocument(app.vault.contents.get(created.path)!), created.project);
});

test('save preserves manual notes, rejects stale revisions, and never overwrites after a conflict', async () => {
  const { app, repository } = setup();
  const created = await repository.create(input);
  const manual = '\n## Manual annotation\nKeep this text, exactly.\n';
  app.vault.externalWrite(created.path, app.vault.contents.get(created.path)! + manual);
  const next = editProject(created.project, { ...input, question: 'Refined question' });
  const saved = await repository.save(created.path, created.project.revision, next, created.fingerprint);
  assert.ok(app.vault.contents.get(created.path)!.endsWith(manual));
  const beforeConflict = app.vault.contents.get(created.path);
  const stale = editProject(created.project, { ...input, question: 'Stale edit' });
  await assert.rejects(repository.save(created.path, created.project.revision, stale, created.fingerprint), /изменён/);
  assert.equal(app.vault.contents.get(created.path), beforeConflict);
  assert.equal(saved.project.question, 'Refined question');
});

test('fingerprints catch external data changes even when the project revision was not incremented', async () => {
  const { app, repository } = setup();
  const created = await repository.create(input);
  const document = app.vault.contents.get(created.path)!;
  const external = document.replace('"question": "Original question"', '"question": "Externally edited"');
  assert.notEqual(external, document);
  app.vault.externalWrite(created.path, external);
  const stale = editProject(created.project, { ...input, question: 'Overwritten?' });
  await assert.rejects(repository.save(created.path, created.project.revision, stale, created.fingerprint), /изменён/);
  assert.equal(app.vault.contents.get(created.path), external);
});

test('both copies of a duplicate project ID are excluded and both paths are identified', async () => {
  const { app, repository, warnings } = setup();
  const created = await repository.create(input);
  const copyPath = 'Search Strategies/conflict-copy.md';
  await app.vault.create(copyPath, createProjectDocument(created.project));
  const listed = await repository.listProjects();
  assert.equal(listed.length, 0);
  assert.ok(warnings.some(message => message.includes(created.path) && message.includes(copyPath)));
});

test('import refuses an existing ID without writing another project, including conflicting copies', async () => {
  const { app, repository } = setup();
  const created = await repository.create(input);
  const before = app.vault.createdPaths.length;
  await assert.rejects(repository.importProject({ ...created.project, title: 'Another file name' }), /ID/);
  assert.equal(app.vault.createdPaths.length, before);
  await app.vault.create('Search Strategies/conflict-copy.md', createProjectDocument(created.project));
  const withCopy = app.vault.createdPaths.length;
  await assert.rejects(repository.importProject({ ...created.project, title: 'Third copy' }), /ID/);
  assert.equal(app.vault.createdPaths.length, withCopy);
});

test('folder changes while existing files are read abort import before an unexpected write', async () => {
  const { app, repository, setFolder } = setup();
  await repository.create(input);
  const pathsBefore = [...app.vault.entries.keys()];
  app.vault.beforeRead = () => { setFolder('Other Folder'); };
  await assert.rejects(repository.importProject(createProject({ ...input, title: 'New project' })), /папк/i);
  assert.deepEqual([...app.vault.entries.keys()], pathsBefore);
});

test('invalid data-folder paths are refused before they can escape the vault or hit config', () => {
  for (const path of ['', '/root', 'C:\\Projects', '../Searches', 'Searches/../Other', '.obsidian', 'Notes/.hidden', 'Notes//Searches', 'Notes/NUL.txt', 'Notes/COM1', 'Notes/bad:name']) {
    assert.throws(() => validateDataFolder(path), /./, path);
  }
  assert.throws(() => validateDataFolder('Config/Data', 'Config'));
  assert.equal(validateDataFolder('Research/Searches'), 'Research/Searches');
});

test('export collisions get a new name and preserve earlier export contents', async () => {
  const { app, repository } = setup();
  const created = await repository.create(input);
  const originalIso = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { return '2026-11-11T12:00:00.000Z'; };
  try {
    const first = await repository.export(created, 'json');
    const firstContents = app.vault.contents.get(first);
    const second = await repository.export(created, 'json');
    assert.notEqual(first, second);
    assert.ok(second.endsWith('-2.json'));
    assert.equal(app.vault.contents.get(first), firstContents);
    assert.deepEqual(JSON.parse(app.vault.contents.get(second)!), created.project);
    assert.ok(app.vault.getAbstractFileByPath(second) instanceof TFile);
    assert.equal((await repository.listProjects()).length, 1);
  } finally { Date.prototype.toISOString = originalIso; }
});
