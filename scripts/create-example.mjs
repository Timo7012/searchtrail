import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['src/model.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: '.test-build/example-model.cjs' });
const require = createRequire(import.meta.url);
const { createProject, addStrategy, addRun, editStrategy, editRun, lastRevision, parseProject } = require('../.test-build/example-model.cjs');
const explanation = 'УЧЕБНЫЙ ПРИМЕР. Поиск не выполнялся. Все числа вымышлены и показывают возможности интерфейса.';
let project = createProject({
  title: 'Демонстрация — прогнозирование отказов',
  question: 'Как документировать поиск методов прогнозирования технического состояния телекоммуникационного оборудования?',
  criteria: 'Учебная карточка. Критерии отбора для реального исследования определяются отдельно.',
  deduplicationNotes: explanation + ' Уникальные публикации здесь не подсчитываются.'
});
const definition = { database: 'Демонстрационная база', platform: 'Учебная площадка — поиск не выполнялся', query: '("telecommunication equipment" OR "network equipment") AND ("failure prediction" OR "fault prediction")', searchFields: 'Название, аннотация, ключевые слова (пример)', filters: 'Без ограничений по типу — учебное значение', publicationRange: '2020–2026', languages: 'Русский, английский', searchUrl: '' };
project = addStrategy(project, { title: 'Прогнозирование отказов оборудования', status: 'active', definition, changeNote: explanation });
const strategy = project.strategies[0];
const runInput = { purpose: 'main', status: 'completed', executedAt: '2026-11-10T10:15:00+03:00', timeZone: 'Europe/Moscow', reportedHits: 37, reportedHitsApproximate: true, screenedRecords: 20, selectedRecords: 4, exportedRecords: 30, durationMinutes: 25, resultUrl: '', exportPath: 'Пример/выгрузка.ris', zoteroLink: '', notes: explanation };
project = addRun(project, strategy.id, lastRevision(strategy).id, runInput);
project = editStrategy(project, strategy.id, { title: strategy.title, status: 'active', definition: { ...definition, query: '("telecommunication equipment" OR "network equipment") AND ("failure prediction" OR "condition monitoring")' }, changeNote: 'Учебная версия 2: изменена группа терминов о методе.' });
project = addRun(project, strategy.id, lastRevision(project.strategies[0]).id, { ...runInput, purpose: 'update', executedAt: '2026-11-11', reportedHits: 58, screenedRecords: 15, selectedRecords: 6, exportedRecords: 45, durationMinutes: 18, exportPath: '' });
project = editRun(project, project.runs[0].id, { ...runInput, selectedRecords: 5 }, 'Учебное исправление количества отобранных записей.');
project = addStrategy(project, { title: 'Диагностика CRPS', status: 'draft', definition: { ...definition, query: '(CRPS OR "server power supply") AND ("fault diagnosis" OR "condition monitoring")' }, changeNote: 'Учебный черновик; выполнения ещё нет.' });
project = addStrategy(project, { title: 'Диагностика SFP/SFP+', status: 'active', definition: { ...definition, query: '(SFP OR "SFP+") AND ("failure prediction" OR degradation)' }, changeNote: 'Учебный запрос для пробного поиска.' });
const sfp = project.strategies[2];
project = addRun(project, sfp.id, lastRevision(sfp).id, { ...runInput, purpose: 'pilot', status: 'partial', executedAt: '2026-11-11', reportedHits: null, reportedHitsApproximate: false, screenedRecords: 0, selectedRecords: 0, exportedRecords: null, durationMinutes: null, exportPath: '', notes: explanation + ' Пустая выдача означает неизвестное значение; просмотрено 0 — известный ноль.' });
parseProject(project);
await mkdir('examples', { recursive: true });
await writeFile('examples/demo-project.json', JSON.stringify(project, null, 2) + '\n');
console.log('Created examples/demo-project.json (fictional demonstration data).');
