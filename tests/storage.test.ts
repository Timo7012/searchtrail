import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, editProject, addStrategy, addRun, lastRevision, type RunInput } from '../src/model';
import { createProjectDocument, readProjectDocument, updateProjectDocument, projectFingerprint } from '../src/storage';

const input = { title: 'Поиск для диссертации', question: 'Какие методы доступны?', criteria: 'Статьи и стандарты', deduplicationNotes: '' };

test('project document round trip preserves non-Latin text, markers, and code fences in data', () => {
  const project = createProject({ ...input, question: 'A\n<!-- research-search:data:start -->\n```json\n{"x":1}\n```\nB' });
  assert.deepEqual(readProjectDocument(createProjectDocument(project)), project);
});

test('updating managed content preserves manual notes and custom frontmatter exactly', () => {
  const initial = createProject(input);
  let content = createProjectDocument(initial);
  content = content.replace('type: research-search-project', 'custom: "мой текст"\ntype: research-search-project');
  content = content.replace('## Собственные заметки', '## Собственные заметки\n\nНе удалять: [[Моя глава]] и https://example.org/\n');
  content += '\nСобственный текст после блока\n';
  const updated = editProject(initial, { ...input, title: 'Другое название' });
  const result = updateProjectDocument(content, updated, initial.revision, projectFingerprint(initial));
  assert.match(result, /custom: "мой текст"/);
  assert.match(result, /Не удалять: \[\[Моя глава\]\] и https:\/\/example.org\//);
  assert.ok(result.endsWith('\nСобственный текст после блока\n'));
  assert.equal(readProjectDocument(result).title, 'Другое название');
});

test('stale concurrent saves and external same-revision JSON edits are refused', () => {
  const initial = createProject(input);
  const next = editProject(initial, { ...input, title: 'Первый редактор' });
  const changed = updateProjectDocument(createProjectDocument(initial), next, initial.revision, projectFingerprint(initial));
  assert.throws(() => updateProjectDocument(changed, next, initial.revision, projectFingerprint(initial)), /изменён/);
  const external = { ...initial, question: 'Внешняя правка без изменения revision' };
  assert.throws(() => updateProjectDocument(createProjectDocument(external), next, initial.revision, projectFingerprint(initial)), /изменён/);
});

test('missing, duplicate, and overlapping structural blocks are refused', () => {
  const project = createProject(input);
  const content = createProjectDocument(project);
  assert.throws(() => readProjectDocument(content.replace('<!-- research-search:data:end -->', '')), /маркер/);
  assert.throws(() => readProjectDocument(content + '\n<!-- research-search:data:start -->\n'), /маркер/);
  assert.throws(() => readProjectDocument(content.replace('"schemaVersion": 1', '"schemaVersion": 99')), /Неподдерживаемая версия/);
  const overlapped = content.replace('<!-- research-search:report:end -->', '').replace('<!-- research-search:data:start -->', '<!-- research-search:data:start -->\n<!-- research-search:report:end -->');
  assert.throws(() => readProjectDocument(overlapped), /пересекаются/);
});

test('historical snapshots survive complete Markdown storage lifecycle', () => {
  let project = createProject(input);
  project = addStrategy(project, { title: 'Прогнозирование', status: 'active', changeNote: 'Начальная версия', definition: { database: 'Example database', platform: 'Example platform', query: '"failure prediction" AND telecommunications', searchFields: 'Title, abstract', filters: '', publicationRange: '2020–2026', languages: 'English', searchUrl: '' } });
  const run: RunInput = { purpose: 'main', status: 'completed', executedAt: '2026-11-11', timeZone: '', reportedHits: null, reportedHitsApproximate: false, screenedRecords: 0, selectedRecords: 0, exportedRecords: 80, durationMinutes: null, resultUrl: '', exportPath: '', zoteroLink: '', notes: '' };
  project = addRun(project, project.strategies[0].id, lastRevision(project.strategies[0]).id, run);
  const restored = readProjectDocument(createProjectDocument(project));
  assert.deepEqual(restored, project);
  assert.equal(restored.runs[0].reportedHits, null);
  assert.equal(restored.runs[0].screenedRecords, 0);
});
