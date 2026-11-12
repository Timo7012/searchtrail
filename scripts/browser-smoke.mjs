/**
 * Optional browser UI smoke test. Uses the real view/model with a minimal
 * Obsidian UI shim and an in-memory host; it is NOT a native Obsidian test.
 * Install Playwright separately or use the managed runtime. No production dep.
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = await mkdtemp(path.join(tmpdir(), 'research-search-browser-'));
const checks = [];

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (error) {
    if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
      return import(pathToFileURL(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs')).href);
    }
    throw new Error('Playwright is not installed. Install it separately and run npx playwright install chromium to use this optional test.', { cause: error });
  }
}

async function executable(chromium) {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed executable. */ }
  }
  throw new Error('No Chromium executable found. Run npx playwright install chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.');
}

await build({
  entryPoints: [path.join(root, 'tests/browser/harness.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2021',
  alias: { obsidian: path.join(root, 'tests/browser/obsidian-mock.ts') },
  outfile: path.join(artifacts, 'harness.js'), logLevel: 'silent',
});

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SearchTrail — UI shim test</title>
<style>
:root { --background-primary:#fff;--background-secondary:#f5f6f8;--background-modifier-border:#dde1e7;--background-modifier-hover:#edf0f5;--background-modifier-error:#e6b0b0;--background-modifier-success:#e7f4ed;--text-normal:#243043;--text-muted:#667085;--text-faint:#7d8798;--text-accent:#5b53b8;--interactive-accent:#6458c3;--text-error:#b42318;--text-success:#267349;--text-warning:#9a6700;--font-monospace:ui-monospace,SFMono-Regular,Consolas,monospace; }
*{box-sizing:border-box}body{margin:0;background:#eef0f4;color:var(--text-normal);font-family:system-ui,sans-serif;font-size:14px}#app{max-width:1100px;margin:auto;background:var(--background-primary);min-height:100vh}button,input,textarea,select{font:inherit;color:inherit}button{cursor:pointer;background:white;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px 11px}button:disabled{opacity:.55;cursor:default}.mod-cta{background:var(--interactive-accent);border-color:var(--interactive-accent);color:white}input,select,textarea{border:1px solid var(--background-modifier-border);border-radius:5px;padding:6px 8px;background:white}input:focus,textarea:focus,select:focus{outline:2px solid #aca4e5;outline-offset:1px}a{color:var(--text-accent)}.modal-container{position:fixed;inset:0;background:#18223666;display:flex;align-items:center;justify-content:center;padding:12px;z-index:20}.modal{background:var(--background-primary);border-radius:12px;padding:22px;box-shadow:0 12px 60px #0003;display:flex;flex-direction:column}.modal-title{font-size:20px;line-height:1.35;margin:0 0 14px}.setting-item{display:flex;align-items:center;border-top:1px solid var(--background-modifier-border)}.setting-item:first-child{border-top:0}.setting-item-info{flex:1}.setting-item-control{display:flex;align-items:center;justify-content:flex-end;gap:8px}.setting-item-description{color:var(--text-muted)}#notices{position:fixed;right:12px;bottom:12px;max-width:320px;pointer-events:none;z-index:30}.notice{margin-top:6px;padding:10px 14px;background:#243043;color:white;border-radius:8px;font-size:12px}.notice:not(:last-child){display:none}
</style><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><div id="notices"></div><script src="/harness.js"></script></body></html>`;
await writeFile(path.join(artifacts, 'index.html'), html, 'utf8');

const routes = {
  '/': { file: path.join(artifacts, 'index.html'), type: 'text/html; charset=utf-8' },
  '/harness.js': { file: path.join(artifacts, 'harness.js'), type: 'application/javascript' },
  '/styles.css': { file: path.join(root, 'styles.css'), type: 'text/css' },
};
const server = createServer(async (request, response) => {
  const route = routes[(request.url ?? '/').split('?')[0]];
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': route.type });
    response.end(await readFile(route.file));
  } catch { response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

let browser;
let page;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ executablePath: await executable(chromium), headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const state = () => page.evaluate(() => window.rssHarness.snapshot());
  const modal = page.getByRole('dialog');
  assert.equal((await state()).projects.length, 0);
  assert.equal(await page.getByText('Начните с исследовательского вопроса', { exact: true }).isVisible(), true);
  checks.push('empty state creates no sample projects');

  await page.getByRole('button', { name: 'Создать первый проект', exact: true }).click();
  await modal.getByLabel('Название *', { exact: true }).fill('Прогнозирование отказов SFP');
  await modal.getByLabel('Исследовательский вопрос', { exact: true }).fill('Какие признаки помогают прогнозировать техническое состояние?');
  await modal.getByLabel('Критерии отбора', { exact: true }).fill('Измерения на оборудовании; описание методики проверки.');
  await modal.getByRole('button', { name: 'Создать проект', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.equal((await state()).projects.length, 1);
  checks.push('project form saves through the host');

  const query1 = '("failure prediction" OR "fault prediction")\nAND (SFP OR transceiver)';
  await page.getByRole('button', { name: 'Новый запрос', exact: true }).click();
  await modal.getByLabel('Название *', { exact: true }).fill('Диагностические признаки оптических модулей');
  await modal.getByLabel('База данных *', { exact: true }).fill('Scopus');
  await modal.getByLabel('Платформа *', { exact: true }).fill('Scopus Web');
  await modal.getByLabel('Точный текст запроса *', { exact: true }).fill(query1);
  await modal.getByRole('button', { name: 'Добавить запрос', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  await page.locator('.rss-strategy-card').waitFor();
  assert.equal((await state()).projects[0].project.strategies[0].revisions[0].definition.query, query1);
  checks.push('strategy preserves exact query text and line breaks');

  await page.getByRole('button', { name: 'Записать поиск', exact: true }).click();
  await modal.getByLabel('Дата поиска *', { exact: true }).fill('2026-11-11');
  await modal.getByLabel('Часовой пояс', { exact: true }).fill('Europe/Moscow');
  await modal.getByLabel('Просмотрено записей', { exact: true }).fill('0');
  await modal.getByLabel('Отобрано после просмотра', { exact: true }).fill('0');
  await modal.getByRole('button', { name: 'Записать выполнение', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  let project = (await state()).projects[0].project;
  assert.equal(project.runs.length, 1);
  assert.equal(project.runs[0].reportedHits, null);
  assert.equal(project.runs[0].screenedRecords, 0);
  assert.equal(project.runs[0].selectedRecords, 0);
  assert.equal(project.runs[0].exportedRecords, null);
  assert.equal(project.runs[0].executedAt, '2026-11-11');
  checks.push('run distinguishes unknown counts from zero and keeps a date without invented time');

  const query2 = `${query1}\nAND (diagnostic OR degradation)`;
  await page.getByRole('button', { name: 'Изменить', exact: true }).click();
  await modal.getByLabel('Точный текст запроса *', { exact: true }).fill(query2);
  await modal.getByLabel('Описание изменения версии', { exact: true }).fill('Добавлены термины диагностики и деградации.');
  await modal.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  project = (await state()).projects[0].project;
  assert.equal(project.strategies[0].revisions.length, 2);
  assert.equal(project.runs[0].queryRevisionNumber, 1);
  assert.equal(project.runs[0].definition.query, query1);
  checks.push('new query revision leaves the previous run snapshot unchanged');

  await page.getByRole('tab', { name: 'Журнал', exact: true }).click();
  const search = page.getByLabel('Найти', { exact: true });
  await search.fill('несуществующая фраза');
  assert.equal(await page.locator('.rss-run-card').count(), 0);
  assert.equal(await search.evaluate(element => element === document.activeElement), true);
  await search.fill('fault prediction');
  assert.equal(await page.locator('.rss-run-card').count(), 1);
  await page.getByLabel('Платформа', { exact: true }).selectOption('Scopus Web');
  await page.getByLabel('Цель поиска', { exact: true }).selectOption('pilot');
  assert.equal(await page.locator('.rss-run-card').count(), 0);
  await page.getByLabel('Цель поиска', { exact: true }).selectOption('main');
  await page.getByLabel('Выполнение', { exact: true }).selectOption('failed');
  assert.equal(await page.locator('.rss-run-card').count(), 0);
  await page.getByLabel('Выполнение', { exact: true }).selectOption('completed');
  await page.getByLabel('С даты', { exact: true }).fill('2026-11-12');
  assert.equal(await page.locator('.rss-run-card').count(), 0);
  await page.getByLabel('С даты', { exact: true }).fill('2026-11-11');
  assert.equal(await page.locator('.rss-run-card').count(), 1);
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  checks.push('journal text, platform, purpose, status and date filters work without losing search focus');

  await page.getByRole('button', { name: 'Исправить запись', exact: true }).click();
  await modal.getByLabel('Показано результатов', { exact: true }).fill('abc');
  await modal.getByLabel('Причина исправления *', { exact: true }).fill('Проверено число результатов.');
  await modal.getByRole('button', { name: 'Сохранить исправление', exact: true }).click();
  assert.equal(await modal.locator('.rss-form-error').isVisible(), true);
  assert.equal((await state()).projects[0].project.runs[0].reportedHits, null);
  await modal.getByLabel('Показано результатов', { exact: true }).fill('0');
  await page.evaluate(() => window.rssHarness.failNextSave('Симулированная ошибка записи: повторите сохранение.'));
  await modal.getByRole('button', { name: 'Сохранить исправление', exact: true }).click();
  await modal.locator('.rss-form-error').filter({ hasText: 'Симулированная ошибка записи' }).waitFor();
  assert.equal(await modal.isVisible(), true);
  assert.equal(await modal.getByLabel('Показано результатов', { exact: true }).inputValue(), '0');
  assert.equal((await state()).projects[0].project.runs[0].reportedHits, null);
  await modal.getByRole('button', { name: 'Сохранить исправление', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  project = (await state()).projects[0].project;
  assert.equal(project.runs[0].reportedHits, 0);
  assert.equal(project.runs[0].history.length, 1);
  assert.equal(project.runs[0].history[0].previous.reportedHits, null);
  assert.equal(project.runs[0].definition.query, query1);
  assert.equal(project.runs[0].queryRevisionNumber, 1);
  checks.push('invalid input and host save failure keep the form open; retry records one correction');

  for (const [index, format] of ['markdown', 'csv', 'json'].entries()) {
    await page.getByLabel('Формат экспорта', { exact: true }).selectOption(format);
    await page.getByRole('button', { name: 'Экспортировать', exact: true }).click();
    await page.waitForFunction(length => window.rssHarness.snapshot().exports.length === length, index + 1);
  }
  assert.deepEqual((await state()).exports.map(item => item.format), ['markdown', 'csv', 'json']);
  checks.push('all three export formats reach the host');
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Исправить запись', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'mobile-modal.png'), fullPage: true });
  assert.equal(await modal.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth), true);
  await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
  checks.push('390 px layout and modal stay within the viewport in the shim');

  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.rssHarness.unmount());
  assert.equal((await state()).subscribers, 0);
  checks.push('view unsubscribe cleanup runs and no browser page errors occur');
  console.log(JSON.stringify({ ok: true, environment: 'Chromium + Obsidian UI shim; not native Obsidian', checks, artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, checks, artifacts, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
