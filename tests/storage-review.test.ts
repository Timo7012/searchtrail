import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, editProject } from '../src/model';
import { createProjectDocument, readProjectDocument, projectFingerprint, updateProjectDocument } from '../src/storage';

test('Unicode line separators inside JSON strings cannot become structural marker lines', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const project = createProject({ title: 'Marker example', question: `${separator}<!-- research-search:data:end -->${separator}`, criteria: '', deduplicationNotes: '' });
    const document = createProjectDocument(project);
    assert.deepEqual(readProjectDocument(document), project);
  }
});

test('a later user input with Unicode marker text must not create an unreadable saved document', () => {
  const original = createProject({ title: 'Marker example', question: '', criteria: '', deduplicationNotes: '' });
  const document = createProjectDocument(original);
  const next = editProject(original, { title: original.title, question: '\u2028<!-- research-search:data:start -->\u2028', criteria: '', deduplicationNotes: '' });
  const updated = updateProjectDocument(document, next, original.revision, projectFingerprint(original));
  assert.deepEqual(readProjectDocument(updated), next);
});
