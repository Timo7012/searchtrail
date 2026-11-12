/**
 * Safe DOM integration smoke: no browser process, HTTP server or network.
 * Real product view/model + the existing Obsidian UI shim + in-memory host.
 * This validates form behavior, never layout or native Obsidian compatibility.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entryPoints: [path.join(root, 'tests/browser/harness.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2021',
  alias: { obsidian: path.join(root, 'tests/browser/obsidian-mock.ts') },
  write: false, logLevel: 'silent',
});

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<!doctype html><html lang="ru"><body><div id="app"></div><div id="notices"></div></body></html>', {
  runScripts: 'outside-only', url: 'https://example.test/', virtualConsole,
});
const { window } = dom;
const { document } = window;
window.structuredClone = globalThis.structuredClone;
window.HTMLElement.prototype.scrollIntoView = function () {};
if (!window.crypto.randomUUID) Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));

const checks = [];
async function waitFor(label, predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`DOM smoke timed out: ${label}`);
}
const modal = () => document.querySelector('[role="dialog"]');
const state = () => window.rssHarness.snapshot();

function control(label, scope = modal() ?? document) {
  const found = [...scope.querySelectorAll('input, textarea, select')].find(element => element.getAttribute('aria-label') === label);
  assert.ok(found, `Missing control: ${label}`);
  return found;
}
function fill(label, value, scope = modal() ?? document) {
  const element = control(label, scope);
  element.value = value;
  element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
function click(label, scope = modal() ?? document) {
  const element = [...scope.querySelectorAll('button')].find(button => button.textContent.trim() === label);
  assert.ok(element, `Missing button: ${label}`);
  assert.equal(element.disabled, false, `Button is disabled: ${label}`);
  element.click();
}
async function save(label) {
  click(label);
  await waitFor(`modal closes after ${label}`, () => modal() === null);
}

try {
  // Evaluate our own locally built bundle; there are no external script/resources.
  window.eval(built.outputFiles[0].text);
  await waitFor('initial render', () => document.body.dataset.ready === 'true');
  assert.equal(state().projects.length, 0);
  assert.ok(document.body.textContent.includes('Начните с исследовательского вопроса'));
  click('Создать первый проект');
  fill('Название *', 'Проверка поисковой стратегии');
  fill('Исследовательский вопрос', 'Какие признаки позволяют прогнозировать отказы SFP?');
  await save('Создать проект');
  assert.equal(state().projects.length, 1);

  const query1 = '("failure prediction" OR "fault prediction")\nAND SFP';
  click('Новый запрос');
  fill('Название *', 'Оптические модули');
  fill('База данных *', 'Scopus');
  fill('Платформа *', 'Scopus Web');
  fill('Точный текст запроса *', query1);
  await save('Добавить запрос');
  assert.equal(state().projects[0].project.strategies[0].revisions[0].definition.query, query1);
  assert.equal(document.querySelectorAll('.rss-strategy-card').length, 1);
  checks.push('empty state → project → query: form saves and exact multiline query is preserved');

  click('Записать поиск');
  fill('Дата поиска *', '2026-11-11');
  fill('Часовой пояс', 'Europe/Moscow');
  fill('Просмотрено записей', '0');
  fill('Отобрано после просмотра', '0');
  await save('Записать выполнение');
  let project = state().projects[0].project;
  assert.equal(project.runs.length, 1);
  assert.equal(project.runs[0].reportedHits, null);
  assert.equal(project.runs[0].screenedRecords, 0);
  assert.equal(project.runs[0].selectedRecords, 0);
  assert.equal(project.runs[0].exportedRecords, null);
  assert.equal(project.runs[0].executedAt, '2026-11-11');
  checks.push('run form preserves blank counts as null, explicit zero as zero, and date-only precision');

  const query2 = `${query1}\nAND degradation`;
  click('Изменить');
  fill('Точный текст запроса *', query2);
  fill('Описание изменения версии', 'Добавлен термин деградации.');
  await save('Сохранить изменения');
  project = state().projects[0].project;
  assert.equal(project.strategies[0].revisions.length, 2);
  assert.equal(project.strategies[0].revisions[1].definition.query, query2);
  assert.equal(project.runs[0].queryRevisionNumber, 1);
  assert.equal(project.runs[0].definition.query, query1);
  checks.push('query edit creates revision 2 while the existing run retains revision 1 and its snapshot');

  click('Журнал');
  click('Исправить запись');
  fill('Показано результатов', 'abc');
  fill('Причина исправления *', 'Проверено число результатов.');
  click('Сохранить исправление');
  await waitFor('invalid count error', () => modal()?.querySelector('.rss-form-error')?.hidden === false);
  assert.equal(state().projects[0].project.runs[0].reportedHits, null);
  assert.equal(control('Показано результатов').value, 'abc');
  fill('Показано результатов', '0');
  window.rssHarness.failNextSave('Симулированная ошибка записи.');
  click('Сохранить исправление');
  await waitFor('host save error', () => modal()?.querySelector('.rss-form-error')?.textContent.includes('Симулированная ошибка записи'));
  assert.ok(modal());
  assert.equal(control('Показано результатов').value, '0');
  assert.equal(control('Причина исправления *').value, 'Проверено число результатов.');
  assert.equal(state().projects[0].project.runs[0].reportedHits, null);
  await save('Сохранить исправление');
  project = state().projects[0].project;
  assert.equal(project.runs[0].reportedHits, 0);
  assert.equal(project.runs[0].history.length, 1);
  assert.equal(project.runs[0].history[0].previous.reportedHits, null);
  assert.equal(project.runs[0].definition.query, query1);
  checks.push('invalid number and failed save keep form/input; retry saves exactly one correction');

  assert.equal(state().subscribers, 1);
  await window.rssHarness.unmount();
  assert.equal(state().subscribers, 0);
  assert.deepEqual(errors, []);
  checks.push('view unsubscribes on close and DOM execution reports no errors');

  console.log(JSON.stringify({ ok: true, environment: 'JSDOM + Obsidian UI shim; no browser, network or layout validation', checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  window.close();
}
