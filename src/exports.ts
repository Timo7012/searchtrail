import { getStats, type Project, type QueryDefinition, type SearchRun } from './model';

const statuses = { draft: 'Черновик', active: 'Активен', paused: 'Приостановлен', done: 'Завершён' };
const runStatuses = { completed: 'Завершён', partial: 'Частично выполнен', failed: 'Не выполнен' };
const purposes = { pilot: 'Пробный поиск', main: 'Основной поиск', update: 'Обновление поиска' };

function csvCell(value: unknown): string {
  let result = value === null || value === undefined ? '' : String(value);
  // Keep CSV safe to open in spreadsheets. JSON retains exact original values.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(result) || /^[\t\r\n]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}

/** One row per CURRENT run. Past corrections remain in JSON and the Markdown report. */
export function projectToCsv(project: Project): string {
  const headers = [
    'project_id', 'project_title', 'project_revision', 'run_id', 'strategy_id', 'strategy_title', 'query_revision_id', 'query_revision_number',
    'purpose', 'status', 'executed_at', 'time_zone', 'database', 'platform', 'exact_query', 'search_fields', 'filters', 'publication_range', 'languages', 'search_url',
    'reported_hits', 'reported_hits_approximate', 'screened_records', 'selected_after_screening', 'exported_records', 'duration_minutes',
    'result_url', 'export_path', 'zotero_link', 'notes', 'recorded_at', 'updated_at', 'corrections_count',
  ];
  const rows = project.runs.map(r => [
    project.id, project.title, project.revision, r.id, r.strategyId, r.strategyTitle, r.queryRevisionId, r.queryRevisionNumber,
    r.purpose, r.status, r.executedAt, r.timeZone, r.definition.database, r.definition.platform, r.definition.query, r.definition.searchFields, r.definition.filters, r.definition.publicationRange, r.definition.languages, r.definition.searchUrl,
    r.reportedHits, r.reportedHitsApproximate, r.screenedRecords, r.selectedRecords, r.exportedRecords, r.durationMinutes,
    r.resultUrl, r.exportPath, r.zoteroLink, r.notes, r.recordedAt, r.updatedAt, r.history.length,
  ]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function inline(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');
}

function cell(value: string | number | null): string { return value === null ? '—' : inline(String(value)); }

/** A sufficiently long fence keeps raw user text inert, including embedded code fences. */
function block(value: string, language = 'text'): string {
  const matches = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...matches.map(x => x.length + 1)));
  return `${fence}${language}\n${value}\n${fence}`;
}

function definitionLines(definition: QueryDefinition): string[] {
  return [
    `- База / базы: ${inline(definition.database)}`,
    `- Платформа: ${inline(definition.platform)}`,
    `- Поля поиска: ${inline(definition.searchFields) || 'не указаны'}`,
    `- Ограничения и фильтры: ${inline(definition.filters) || 'не указаны'}`,
    `- Период публикаций: ${inline(definition.publicationRange) || 'не указан'}`,
    `- Языки: ${inline(definition.languages) || 'не указаны'}`,
    `- Адрес поиска: ${inline(definition.searchUrl) || 'не указан'}`,
    '', 'Точная строка запроса:', '', block(definition.query), '',
  ];
}

function runDetails(run: Omit<SearchRun, 'history'>): string[] {
  return [
    `- Дата поиска: ${inline(run.executedAt)}${run.timeZone ? `; часовой пояс: ${inline(run.timeZone)}` : ' (время не указано)'}`,
    `- Цель: ${purposes[run.purpose]}; статус: ${runStatuses[run.status]}`,
    `- Показано результатов: ${cell(run.reportedHits)}${run.reportedHitsApproximate ? ' (приблизительно)' : ''}`,
    `- Просмотрено записей: ${cell(run.screenedRecords)}`,
    `- Отобрано после просмотра: ${cell(run.selectedRecords)}`,
    `- Выгружено записей: ${cell(run.exportedRecords)}`,
    `- Длительность, минут: ${cell(run.durationMinutes)}`,
    `- Адрес результатов: ${inline(run.resultUrl) || 'не указан'}`,
    `- Файл выгрузки: ${inline(run.exportPath) || 'не указан'}`,
    `- Ссылка Zotero: ${inline(run.zoteroLink) || 'не указана'}`,
    `- Записано: ${inline(run.recordedAt)}`,
    `- Последнее исправление: ${inline(run.updatedAt)}`,
    '', 'Заметки:', '', block(run.notes || 'Не указаны.'), '',
  ];
}

export function projectToMarkdown(project: Project): string {
  const stats = getStats(project);
  const lines: string[] = [
    `# Поисковая стратегия: ${inline(project.title)}`, '',
    `Проект: ${inline(project.id)}. Редакция данных: ${project.revision}.`, '',
    `Создан: ${inline(project.createdAt)}. Изменён: ${inline(project.updatedAt)}.`, '',
    '## Исследовательский вопрос', '', block(project.question || 'Не указан.'), '',
    '## Критерии и границы поиска', '', block(project.criteria || 'Не указаны.'), '',
    '## Учёт дубликатов', '', block(project.deduplicationNotes || 'Метод устранения дубликатов не описан.'), '',
    '## Статистика журнала', '',
    `Запросов: **${stats.strategyCount}**. Выполнений: **${stats.runCount}**.`, '',
    '| Показатель | Сумма известных значений | Заполнено выполнений |',
    '| --- | ---: | ---: |',
  ];
  const metrics = [['Показано результатов', stats.totals.reportedHits], ['Просмотрено записей', stats.totals.screenedRecords], ['Отобрано после просмотра', stats.totals.selectedRecords], ['Выгружено записей', stats.totals.exportedRecords]] as const;
  for (const [label, total] of metrics) lines.push(`| ${label} | ${total.known ? total.sum : '—'} | ${total.known} / ${total.total} |`);
  lines.push('', 'Это суммы записей журнала, включая пробные, частичные и повторные выполнения. Пересечения между базами и повторы не устранены; число уникальных публикаций и исследований не вычисляется. «—» означает неизвестное значение, а не ноль. Отбор после просмотра не равен окончательному включению в обзор. Для данных с датой без времени порядок выполнений внутри дня неизвестен.', '', '## Запросы и версии', '');
  for (const strategy of project.strategies) {
    lines.push(`### ${inline(strategy.title)}`, '', `Статус: ${statuses[strategy.status]}. ID: ${inline(strategy.id)}.`, '');
    for (const revision of strategy.revisions) {
      lines.push(`#### Версия ${revision.number}`, '', `Создана: ${inline(revision.createdAt)}. ID: ${inline(revision.id)}.`, '', `Изменение: ${inline(revision.changeNote) || 'не описано'}`, '', ...definitionLines(revision.definition));
    }
  }
  if (!project.strategies.length) lines.push('Запросы ещё не добавлены.', '');
  lines.push('## Журнал выполнений', '', '| Дата | Запрос | Версия | Цель | Статус | Показано | Просмотрено | Отобрано | Выгружено |', '| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |');
  for (const run of project.runs) lines.push(`| ${cell(run.executedAt)} | ${cell(run.strategyTitle)} | ${run.queryRevisionNumber} | ${purposes[run.purpose]} | ${runStatuses[run.status]} | ${run.reportedHitsApproximate && run.reportedHits !== null ? '≈ ' : ''}${cell(run.reportedHits)} | ${cell(run.screenedRecords)} | ${cell(run.selectedRecords)} | ${cell(run.exportedRecords)} |`);
  lines.push('', '## Подробности и исправления', '');
  for (const run of project.runs) {
    lines.push(`### ${inline(run.executedAt)} — ${inline(run.strategyTitle)}`, '', `ID выполнения: ${inline(run.id)}. Использована версия **${run.queryRevisionNumber}**.`, '', ...runDetails(run), '#### Снимок условий поиска', '', ...definitionLines(run.definition));
    if (run.history.length) {
      lines.push('#### История исправлений', '');
      run.history.forEach((change, index) => lines.push(`##### Исправление ${index + 1}`, '', `Дата: ${inline(change.changedAt)}. Причина: ${inline(change.reason)}.`, '', 'Значения до исправления:', '', ...runDetails(change.previous)));
    }
  }
  return lines.join('\n') + '\n';
}

export function projectToJson(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n';
}
