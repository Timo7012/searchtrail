import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, addStrategy, editStrategy, addRun, editRun, editProject, lastRevision, getStats, parseProject, type Project, type QueryDefinition, type RunInput } from '../src/model';
import { projectToCsv, projectToMarkdown, projectToJson } from '../src/exports';

const definition: QueryDefinition = {
  database: 'IEEE Xplore', platform: 'IEEE Xplore', query: '("telecom equipment" OR SFP) AND failure', searchFields: 'Title, Abstract', filters: 'Articles', publicationRange: '2020–2026', languages: 'English', searchUrl: 'https://ieeexplore.ieee.org/',
};
const run: RunInput = {
  purpose: 'main', status: 'completed', executedAt: '2026-11-11T17:30:00+03:00', timeZone: 'Europe/Moscow', reportedHits: 1000, reportedHitsApproximate: true,
  screenedRecords: 20, selectedRecords: 3, exportedRecords: 1000, durationMinutes: 12.5, resultUrl: 'https://example.org/results', exportPath: 'Searches/ieee.ris', zoteroLink: 'zotero://select/library/collections/ABCDEFGH', notes: 'Checked metadata.',
};

function base(): Project {
  return addStrategy(createProject({ title: 'Telecom reliability', question: 'How to forecast failures?', criteria: 'Equipment telemetry', deduplicationNotes: 'Not yet deduplicated.' }), { title: 'Initial query', status: 'active', definition, changeNote: 'Initial version' });
}
function executed(): Project {
  const p = base(), s = p.strategies[0];
  return addRun(p, s.id, lastRevision(s).id, run);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('a changed query creates a revision without changing old execution snapshots', () => {
  const original = deepFreeze(executed());
  const changed = editStrategy(original, original.strategies[0].id, { title: 'Refined query', status: 'active', definition: { ...definition, query: 'CRPS AND failure', filters: 'Conference papers' }, changeNote: 'Broaden equipment type' });
  assert.equal(changed.strategies[0].revisions.length, 2);
  assert.equal(changed.strategies[0].revisions[1].number, 2);
  assert.equal(changed.runs[0].definition.query, definition.query);
  assert.equal(changed.runs[0].definition.filters, definition.filters);
  assert.equal(changed.runs[0].strategyTitle, 'Initial query');
  assert.equal(original.strategies[0].revisions.length, 1);
  assert.equal(changed.revision, original.revision + 1);
});

test('historical query revisions can be selected for a new execution', () => {
  let p = base();
  const firstRevision = p.strategies[0].revisions[0].id;
  p = editStrategy(p, p.strategies[0].id, { title: 'Changed', status: 'active', definition: { ...definition, query: 'CRPS' }, changeNote: 'New query' });
  p = addRun(p, p.strategies[0].id, firstRevision, run);
  assert.equal(p.runs[0].queryRevisionNumber, 1);
  assert.equal(p.runs[0].definition.query, definition.query);
  assert.deepEqual(parseProject(p), p);
});

test('changing only a strategy status does not create a fictitious query revision', () => {
  const p = base();
  const edited = editStrategy(p, p.strategies[0].id, { title: 'Initial query', status: 'done', definition, changeNote: '' });
  assert.equal(edited.strategies[0].revisions.length, 1);
  assert.equal(edited.strategies[0].status, 'done');
});

test('run corrections preserve identity, immutable snapshot, and previous values', () => {
  const original = deepFreeze(executed());
  const corrected = editRun(original, original.runs[0].id, { ...run, screenedRecords: 50, selectedRecords: 9, notes: 'Continued screening.' }, 'Recorded completed screening');
  assert.equal(corrected.runs.length, 1);
  assert.equal(corrected.runs[0].screenedRecords, 50);
  assert.equal(corrected.runs[0].history[0].previous.screenedRecords, 20);
  assert.equal(corrected.runs[0].history[0].reason, 'Recorded completed screening');
  assert.deepEqual(corrected.runs[0].definition, original.runs[0].definition);
  assert.equal(corrected.runs[0].recordedAt, original.runs[0].recordedAt);
  assert.equal(original.runs[0].history.length, 0);
  assert.deepEqual(parseProject(corrected), corrected);
  assert.throws(() => editRun(original, original.runs[0].id, run, '  '), /Причина исправления/);
});

test('unknown counts differ from a known zero; sums disclose known-value coverage', () => {
  let p = base();
  const s = p.strategies[0];
  p = addRun(p, s.id, lastRevision(s).id, { ...run, reportedHits: null, screenedRecords: null, selectedRecords: null, exportedRecords: null });
  p = addRun(p, s.id, lastRevision(s).id, { ...run, reportedHits: 0, screenedRecords: 0, selectedRecords: 0, exportedRecords: 0 });
  const stats = getStats(p);
  assert.deepEqual(stats.totals.reportedHits, { sum: 0, known: 1, total: 2 });
  assert.deepEqual(stats.totals.selectedRecords, { sum: 0, known: 1, total: 2 });
  assert.equal(stats.runCount, 2);
});

test('bulk exports can exceed screened records and approximate displayed hits', () => {
  const p = base(), s = p.strategies[0];
  const result = addRun(p, s.id, lastRevision(s).id, { ...run, reportedHits: 500, screenedRecords: 20, selectedRecords: 0, exportedRecords: 1000 });
  assert.equal(result.runs[0].exportedRecords, 1000);
});

test('invalid, fractional and unsafe counts fail, as does selecting beyond screened count', () => {
  const p = base(), s = p.strategies[0];
  for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addRun(p, s.id, lastRevision(s).id, { ...run, reportedHits: bad }), /целое число/);
  }
  assert.throws(() => addRun(p, s.id, lastRevision(s).id, { ...run, screenedRecords: 2, selectedRecords: 3 }), /не может превышать/);
});

test('calendar dates and ISO offsets are validated without inventing missing time', () => {
  const p = base(), s = p.strategies[0];
  for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-11-11T17:30:00', '2026-11-11T25:00:00Z', '2026-11-11T17:30:00+03:99']) {
    assert.throws(() => addRun(p, s.id, lastRevision(s).id, { ...run, executedAt: bad }));
  }
  const dateOnly = addRun(p, s.id, lastRevision(s).id, { ...run, executedAt: '2024-02-29', timeZone: '' });
  assert.equal(dateOnly.runs[0].executedAt, '2024-02-29');
  assert.equal(dateOnly.runs[0].timeZone, '');
  const offset = addRun(p, s.id, lastRevision(s).id, { ...run, executedAt: '2026-11-11T17:30:00+03:00' });
  assert.equal(offset.runs[0].executedAt, '2026-11-11T17:30:00+03:00');
  assert.throws(() => addRun(p, s.id, lastRevision(s).id, { ...run, timeZone: 'Not/AZone' }), /IANA/);
});

test('future schemas and unknown fields are refused rather than dropped', () => {
  const p = executed();
  assert.throws(() => parseProject({ ...p, schemaVersion: 2 }), /версия данных/);
  assert.throws(() => parseProject({ ...p, aFutureField: 'keep me' }), /неизвестные поля/);
  assert.throws(() => parseProject({ ...p, title: 42 }), /ожидается текст/);
});

test('a corrupted snapshot or mismatched audit identity fails parsing', () => {
  const original = executed();
  const p = JSON.parse(projectToJson(original));
  p.runs[0].definition.query = 'silently edited old search';
  assert.throws(() => parseProject(p), /Снимок запроса/);
  const corrected = editRun(original, original.runs[0].id, run, 'fix');
  corrected.runs[0].history[0].previous.id = 'wrong-id';
  assert.throws(() => parseProject(corrected), /История исправлений/);
});

test('foreign query references, duplicate run IDs and malformed nullable data are refused', () => {
  const p = executed();
  const duplicate = JSON.parse(projectToJson(p));
  duplicate.runs.push(duplicate.runs[0]);
  assert.throws(() => parseProject(duplicate), /Повторяющийся ID выполнения/);
  const missing = JSON.parse(projectToJson(p));
  missing.runs[0].queryRevisionId = 'missing';
  assert.throws(() => parseProject(missing), /Снимок запроса/);
  const malformed = JSON.parse(projectToJson(p));
  malformed.runs[0].reportedHits = '12';
  assert.throws(() => parseProject(malformed), /целое число/);
});

test('CSV quotes multiline queries, neutralizes spreadsheet formulas and preserves zero', () => {
  let p = base();
  const s = p.strategies[0];
  p = editStrategy(p, s.id, { title: '=HYPERLINK("bad")', status: 'active', definition: { ...definition, query: '+malicious()\n"exact, query"' }, changeNote: '' });
  p = addRun(p, s.id, lastRevision(p.strategies[0]).id, { ...run, reportedHits: 0, notes: '\t=HYPERLINK("bad")' });
  const csv = projectToCsv(p);
  assert.ok(csv.startsWith('\uFEFF"project_id"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"\'+malicious()\n""exact, query"""'));
  assert.ok(csv.includes('"\'\t=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes(',"0","true",'));
  assert.equal(JSON.parse(projectToJson(p)).runs[0].definition.query, '+malicious()\n"exact, query"');
});

test('reports preserve revisions and correction history without falsely claiming uniqueness', () => {
  let p = executed();
  p = editRun(p, p.runs[0].id, { ...run, notes: 'Updated note' }, 'Correction reason');
  const report = projectToMarkdown(p);
  assert.ok(report.includes('Пересечения между базами и повторы не устранены'));
  assert.ok(report.includes('Correction reason'));
  assert.ok(report.includes('Checked metadata.'));
  assert.ok(report.includes('Updated note'));
  assert.deepEqual(parseProject(JSON.parse(projectToJson(p))), p);
});

test('Markdown user values stay inert even with markup and code fences', () => {
  let p = base();
  p = editProject(p, { title: '<script>x</script> [[link]]', question: '```\n<script>malicious</script>\n```', criteria: '', deduplicationNotes: '' });
  const report = projectToMarkdown(p);
  assert.ok(report.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(report.includes('````text\n```\n<script>malicious</script>\n```\n````'));
});
