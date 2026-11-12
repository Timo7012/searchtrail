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
  assert.ok(document.body.textContent.includes('Начните с цели поиска'));
  click('Новый проект');
  assert.equal(document.querySelector('.rss-menu-trigger').getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('[role="menu"]'));
  click('Импортировать из JSON');
  assert.equal(document.querySelector('.rss-menu-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.querySelector('.rss-import-bar'), null);
  assert.ok(control('Файл проекта JSON'));
  fill('JSON проекта', '{broken JSON');
  click('Импортировать');
  await waitFor('invalid import stays open', () => modal()?.querySelector('[role="alert"]')?.textContent.length > 0);
  assert.equal(control('JSON проекта').value, '{broken JSON');
  assert.equal(state().projects.length, 0);
  click('Отмена');
  checks.push('New project menu offers import without projects, resets expanded state; invalid JSON preserves input and creates nothing');
  click('Создать первый проект');
  click('Создать пустой проект');
  fill('Название *', 'Проверка поисковой стратегии');
  fill('Цель / вопрос поиска', 'Какие признаки позволяют прогнозировать отказы SFP?');
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

  const projectBeforeMaterials = JSON.stringify(state().projects[0].project);
  click('Материалы');
  click('Добавить материал');
  fill('Название материала *', 'Внутренняя инструкция без DOI');
  fill('Тип материала', 'documentation');
  await save('Добавить материал');
  let catalog = state().projects[0].catalog;
  assert.equal(catalog.materials.length, 1);
  assert.equal(catalog.materials[0].doi, '');
  assert.equal(catalog.materials[0].year, null);
  assert.equal(JSON.stringify(state().projects[0].project), projectBeforeMaterials);
  assert.equal(document.querySelectorAll('.rss-material-card').length, 1);
  checks.push('materials accept a work document without DOI/authors/year and leave project v1 and run counters unchanged');

  click('Изменить материал');
  fill('Чтение / просмотр', 'read');
  fill('Решение по материалу', 'excluded');
  click('Сохранить материал');
  await waitFor('exclusion reason required', () => modal()?.querySelector('.rss-form-error')?.hidden === false);
  assert.equal(control('Название материала *').value, 'Внутренняя инструкция без DOI');
  fill('Причина исключения', 'Другая модель устройства');
  await save('Сохранить материал');
  catalog = state().projects[0].catalog;
  assert.equal(catalog.materials[0].history.length, 1);
  assert.equal(catalog.materials[0].decision, 'excluded');
  fill('Решение по материалу', 'selected', document);
  assert.equal(document.querySelectorAll('.rss-material-card').length, 0);
  fill('Решение по материалу', 'excluded', document);
  assert.equal(document.querySelectorAll('.rss-material-card').length, 1);
  click('Сбросить фильтры');
  checks.push('material edits require exclusion reason, preserve input and history; material filters work');

  const imported = { ...state().projects[0].project, id: randomUUID(), title: 'Импортированный проект' };
  const importedCatalog = { ...state().projects[0].catalog, projectId: imported.id };
  const bundle = { format: 'searchtrail-project', transferVersion: 1, project: imported, catalog: importedCatalog };
  click('Новый проект');
  click('Импортировать из JSON');
  fill('JSON проекта', JSON.stringify(bundle));
  await save('Импортировать');
  await waitFor('imported project selected', () => control('Поисковый проект', document).value === imported.id);
  assert.equal(state().projects.length, 2);
  // Compare data across the JSDOM and Node realms without prototype identity.
  assert.deepEqual(JSON.parse(JSON.stringify(state().projects[1].project)), JSON.parse(JSON.stringify(imported)));
  assert.deepEqual(JSON.parse(JSON.stringify(state().projects[1].catalog)), JSON.parse(JSON.stringify(importedCatalog)));
  click('Новый проект');
  click('Импортировать из JSON');
  fill('JSON проекта', JSON.stringify(bundle));
  click('Импортировать');
  await waitFor('duplicate import error', () => modal()?.querySelector('[role="alert"]')?.textContent.includes('ID уже существует'));
  assert.equal(state().projects.length, 2);
  assert.equal(control('JSON проекта').value, JSON.stringify(bundle));
  click('Отмена');
  checks.push('panel import selects the new project and preserves revisions/history; duplicate import keeps input without creating a copy');

  assert.equal(state().subscribers, 1);
  click('Новый проект');
  assert.ok(document.querySelector('[role="menu"]'));
  await window.rssHarness.unmount();
  assert.equal(document.querySelector('[role="menu"]'), null);
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
