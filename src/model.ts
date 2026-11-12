/** Portable domain model. No Obsidian, Node, storage, or network dependencies. */
export type StrategyStatus = 'draft' | 'active' | 'paused' | 'done';

export interface ProjectInput {
  title: string;
  question: string;
  criteria: string;
  deduplicationNotes: string;
}

export interface QueryDefinition {
  database: string;
  platform: string;
  query: string;
  searchFields: string;
  filters: string;
  publicationRange: string;
  languages: string;
  searchUrl: string;
}

export interface StrategyInput {
  title: string;
  status: StrategyStatus;
  definition: QueryDefinition;
  changeNote: string;
}

export interface QueryRevision {
  id: string;
  number: number;
  createdAt: string;
  changeNote: string;
  definition: QueryDefinition;
}

export interface Strategy {
  id: string;
  title: string;
  status: StrategyStatus;
  createdAt: string;
  updatedAt: string;
  revisions: QueryRevision[];
}

export interface RunInput {
  purpose: 'pilot' | 'main' | 'update';
  status: 'completed' | 'partial' | 'failed';
  executedAt: string;
  timeZone: string;
  reportedHits: number | null;
  reportedHitsApproximate: boolean;
  screenedRecords: number | null;
  selectedRecords: number | null;
  exportedRecords: number | null;
  durationMinutes: number | null;
  resultUrl: string;
  exportPath: string;
  zoteroLink: string;
  notes: string;
}

export interface SearchRun extends RunInput {
  id: string;
  strategyId: string;
  strategyTitle: string;
  queryRevisionId: string;
  queryRevisionNumber: number;
  definition: QueryDefinition;
  recordedAt: string;
  updatedAt: string;
  history: RunChange[];
}

export interface RunChange {
  changedAt: string;
  reason: string;
  previous: Omit<SearchRun, 'history'>;
}

export interface Project extends ProjectInput {
  schemaVersion: 1;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  strategies: Strategy[];
  runs: SearchRun[];
}

export interface KnownTotal {
  /** Sum of run-level counts, including repeated records and overlap. */
  sum: number;
  known: number;
  total: number;
}

export interface ProjectStats {
  strategyCount: number;
  runCount: number;
  latestExecutedAt: string | null;
  totals: {
    reportedHits: KnownTotal;
    screenedRecords: KnownTotal;
    selectedRecords: KnownTotal;
    exportedRecords: KnownTotal;
  };
}

const PROJECT_INPUT_KEYS = ['title', 'question', 'criteria', 'deduplicationNotes'];
const DEFINITION_KEYS = ['database', 'platform', 'query', 'searchFields', 'filters', 'publicationRange', 'languages', 'searchUrl'];
const RUN_INPUT_KEYS = ['purpose', 'status', 'executedAt', 'timeZone', 'reportedHits', 'reportedHitsApproximate', 'screenedRecords', 'selectedRecords', 'exportedRecords', 'durationMinutes', 'resultUrl', 'exportPath', 'zoteroLink', 'notes'];
const RUN_SNAPSHOT_KEYS = [...RUN_INPUT_KEYS, 'id', 'strategyId', 'strategyTitle', 'queryRevisionId', 'queryRevisionNumber', 'definition', 'recordedAt', 'updatedAt'];
const STRATEGY_STATUSES: StrategyStatus[] = ['draft', 'active', 'paused', 'done'];

function fail(message: string): never { throw new Error(message); }

function record(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: ожидается объект.`);
  const result = value as Record<string, unknown>;
  const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(result, key));
  if (missing.length) fail(`${label}: отсутствуют поля ${missing.join(', ')}.`);
  const extras = Object.keys(result).filter(key => !keys.includes(key));
  if (extras.length) fail(`${label}: неизвестные поля ${extras.join(', ')}. Данные не изменены.`);
  return result;
}

function text(value: unknown, label: string, required = false): asserts value is string {
  if (typeof value !== 'string') fail(`${label}: ожидается текст.`);
  if (required && !value.trim()) fail(`${label}: заполните поле.`);
}

function integer(value: unknown, label: string, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(`${label}: требуется целое число не меньше ${min}.`);
}

function nullableCount(value: unknown, label: string): void {
  if (value !== null) integer(value, label);
}

/** Validates calendar dates before Date.parse, which otherwise normalizes e.g. February 30. */
function date(value: unknown, label: string, allowDateOnly = false): asserts value is string {
  text(value, label, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || (!allowDateOnly && !match[4])) fail(`${label}: используйте ${allowDateOnly ? 'YYYY-MM-DD или ' : ''}ISO 8601 со смещением часового пояса, например 2026-11-11T17:30:00+03:00.`);
  const [, y, m, d, h, min, sec, , offset] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail(`${label}: такой календарной даты не существует.`);
  if (h !== undefined && (Number(h) > 23 || Number(min) > 59 || Number(sec || 0) > 59)) fail(`${label}: некорректное время.`);
  if (offset && offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) fail(`${label}: некорректное смещение часового пояса.`);
  if (!Number.isFinite(Date.parse(value))) fail(`${label}: некорректная дата.`);
}

function url(value: unknown, label: string, allowZotero = false): void {
  text(value, label);
  if (!value) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail(`${label}: введите полный URL.`); }
  if (!['https:', 'http:', ...(allowZotero ? ['zotero:'] : [])].includes(parsed.protocol)) fail(`${label}: допускаются только HTTP(S)${allowZotero ? ' и zotero://' : ''} ссылки.`);
}

function validateProjectInput(input: ProjectInput): void {
  const x = record(input, 'Проект', PROJECT_INPUT_KEYS);
  for (const key of PROJECT_INPUT_KEYS) text(x[key], `Проект / ${key}`, key === 'title');
}

function validateDefinition(value: unknown): void {
  const x = record(value, 'Описание запроса', DEFINITION_KEYS);
  for (const key of DEFINITION_KEYS) text(x[key], `Запрос / ${key}`, ['database', 'platform', 'query'].includes(key));
  url(x.searchUrl, 'Адрес поиска');
}

function validateStrategyInput(input: StrategyInput): void {
  record(input, 'Стратегия', ['title', 'status', 'definition', 'changeNote']);
  text(input.title, 'Название запроса', true);
  if (!STRATEGY_STATUSES.includes(input.status)) fail('Неизвестный статус запроса.');
  text(input.changeNote, 'Причина изменения запроса');
  validateDefinition(input.definition);
}

function validateRunInput(input: RunInput): void {
  record(input, 'Выполнение поиска', RUN_INPUT_KEYS);
  if (!['pilot', 'main', 'update'].includes(input.purpose)) fail('Неизвестная цель выполнения поиска.');
  if (!['completed', 'partial', 'failed'].includes(input.status)) fail('Неизвестный статус выполнения поиска.');
  date(input.executedAt, 'Дата поиска', true);
  text(input.timeZone, 'Часовой пояс');
  if (input.timeZone) {
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(0); }
    catch { fail('Часовой пояс: используйте IANA-имя, например Europe/Moscow, или UTC.'); }
  } else if (input.executedAt.includes('T')) fail('Укажите часовой пояс для даты со временем.');
  nullableCount(input.reportedHits, 'Показано результатов');
  nullableCount(input.screenedRecords, 'Просмотрено записей');
  nullableCount(input.selectedRecords, 'Отобрано после просмотра');
  nullableCount(input.exportedRecords, 'Выгружено записей');
  if (typeof input.reportedHitsApproximate !== 'boolean') fail('Приблизительное число результатов: ожидается логическое значение.');
  if (input.selectedRecords !== null && input.screenedRecords !== null && input.selectedRecords > input.screenedRecords) fail('Число отобранных после просмотра записей не может превышать число просмотренных в этом выполнении.');
  if (input.durationMinutes !== null && (typeof input.durationMinutes !== 'number' || !Number.isFinite(input.durationMinutes) || input.durationMinutes < 0)) fail('Длительность: требуется число минут не меньше нуля.');
  for (const key of ['resultUrl', 'exportPath', 'zoteroLink', 'notes'] as const) text(input[key], key);
  url(input.resultUrl, 'Адрес результатов');
  url(input.zoteroLink, 'Ссылка Zotero', true);
}

function inputFromRun(run: RunInput): RunInput {
  const result = {} as RunInput;
  for (const key of RUN_INPUT_KEYS as (keyof RunInput)[]) (result as unknown as Record<string, unknown>)[key] = run[key];
  return result;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function uid(): string { return globalThis.crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }
function touch(project: Project): Project {
  const next = clone(project);
  next.revision += 1;
  next.updatedAt = now();
  return next;
}
function definitionEqual(a: QueryDefinition, b: QueryDefinition): boolean {
  return DEFINITION_KEYS.every(key => a[key as keyof QueryDefinition] === b[key as keyof QueryDefinition]);
}

export function createProject(input: ProjectInput): Project {
  validateProjectInput(input);
  const at = now();
  return { ...clone(input), title: input.title.trim(), schemaVersion: 1, id: uid(), revision: 1, createdAt: at, updatedAt: at, strategies: [], runs: [] };
}

export function editProject(project: Project, input: ProjectInput): Project {
  validateProjectInput(input);
  return { ...touch(project), ...clone(input), title: input.title.trim() };
}

export function lastRevision(strategy: Strategy): QueryRevision {
  if (!strategy.revisions.length) fail('У запроса отсутствует версия.');
  return strategy.revisions[strategy.revisions.length - 1];
}

export function addStrategy(project: Project, input: StrategyInput): Project {
  validateStrategyInput(input);
  const next = touch(project), at = next.updatedAt;
  next.strategies.push({ id: uid(), title: input.title.trim(), status: input.status, createdAt: at, updatedAt: at, revisions: [{ id: uid(), number: 1, createdAt: at, changeNote: input.changeNote, definition: clone(input.definition) }] });
  return next;
}

export function editStrategy(project: Project, id: string, input: StrategyInput): Project {
  validateStrategyInput(input);
  const next = touch(project), strategy = next.strategies.find(x => x.id === id);
  if (!strategy) fail('Запрос не найден. Обновите проект.');
  const latest = lastRevision(strategy);
  if (!definitionEqual(latest.definition, input.definition)) {
    strategy.revisions.push({ id: uid(), number: latest.number + 1, createdAt: next.updatedAt, changeNote: input.changeNote, definition: clone(input.definition) });
  }
  strategy.title = input.title.trim();
  strategy.status = input.status;
  strategy.updatedAt = next.updatedAt;
  return next;
}

export function addRun(project: Project, strategyId: string, revisionId: string, input: RunInput): Project {
  validateRunInput(input);
  const next = touch(project), strategy = next.strategies.find(x => x.id === strategyId);
  if (!strategy) fail('Запрос не найден. Обновите проект.');
  const revision = strategy.revisions.find(x => x.id === revisionId);
  if (!revision) fail('Версия запроса не найдена.');
  next.runs.push({ ...clone(input), id: uid(), strategyId, strategyTitle: strategy.title, queryRevisionId: revision.id, queryRevisionNumber: revision.number, definition: clone(revision.definition), recordedAt: next.updatedAt, updatedAt: next.updatedAt, history: [] });
  return next;
}

export function editRun(project: Project, runId: string, input: RunInput, reason: string): Project {
  validateRunInput(input);
  text(reason, 'Причина исправления', true);
  const next = touch(project), index = next.runs.findIndex(x => x.id === runId);
  if (index === -1) fail('Выполнение поиска не найдено. Обновите проект.');
  const current = next.runs[index];
  const { history, ...previous } = current;
  next.runs[index] = { ...current, ...clone(input), updatedAt: next.updatedAt, history: [...history, { changedAt: next.updatedAt, reason: reason.trim(), previous }] };
  return next;
}

/** Refuses damaged or future schemas rather than silently coercing or dropping fields. */
export function parseProject(value: unknown): Project {
  const p = record(value, 'Файл проекта', [...PROJECT_INPUT_KEYS, 'schemaVersion', 'id', 'revision', 'createdAt', 'updatedAt', 'strategies', 'runs']);
  if (p.schemaVersion !== 1) fail('Неподдерживаемая версия данных. Обновите плагин; файл не изменён.');
  validateProjectInput(Object.fromEntries(PROJECT_INPUT_KEYS.map(k => [k, p[k]])) as unknown as ProjectInput);
  text(p.id, 'ID проекта', true); integer(p.revision, 'Редакция проекта', 1);
  date(p.createdAt, 'Дата создания проекта'); date(p.updatedAt, 'Дата изменения проекта');
  if (!Array.isArray(p.strategies) || !Array.isArray(p.runs)) fail('Стратегии и выполнения должны быть массивами.');
  const strategyIds = new Set<string>(), revisionIds = new Set<string>(), runIds = new Set<string>();
  const strategies = new Map<string, Strategy>();
  for (const item of p.strategies) {
    const s = record(item, 'Запрос', ['id', 'title', 'status', 'createdAt', 'updatedAt', 'revisions']);
    text(s.id, 'ID запроса', true); text(s.title, 'Название запроса', true);
    if (strategyIds.has(s.id)) fail('Повторяющийся ID запроса.'); strategyIds.add(s.id);
    if (!STRATEGY_STATUSES.includes(s.status as StrategyStatus)) fail('Неизвестный статус запроса.');
    date(s.createdAt, 'Дата создания запроса'); date(s.updatedAt, 'Дата изменения запроса');
    if (!Array.isArray(s.revisions) || !s.revisions.length) fail('У запроса должна быть хотя бы одна версия.');
    s.revisions.forEach((item: unknown, index: number) => {
      const rev = record(item, 'Версия запроса', ['id', 'number', 'createdAt', 'changeNote', 'definition']);
      text(rev.id, 'ID версии', true); integer(rev.number, 'Номер версии', 1);
      if (rev.number !== index + 1) fail('Нарушен порядок версий запроса.');
      if (revisionIds.has(rev.id)) fail('Повторяющийся ID версии.'); revisionIds.add(rev.id);
      date(rev.createdAt, 'Дата версии'); text(rev.changeNote, 'Описание изменения'); validateDefinition(rev.definition);
    });
    strategies.set(s.id, item as Strategy);
  }
  const validateSnapshot = (item: unknown, label: string): Omit<SearchRun, 'history'> => {
    const r = record(item, label, RUN_SNAPSHOT_KEYS);
    validateRunInput(inputFromRun(r as unknown as RunInput));
    for (const key of ['id', 'strategyId', 'strategyTitle', 'queryRevisionId']) text(r[key], `${label} / ${key}`, true);
    integer(r.queryRevisionNumber, 'Номер использованной версии', 1);
    validateDefinition(r.definition); date(r.recordedAt, 'Дата записи'); date(r.updatedAt, 'Дата исправления');
    const strategy = strategies.get(r.strategyId as string);
    const revision = strategy?.revisions.find(x => x.id === r.queryRevisionId);
    if (!revision || revision.number !== r.queryRevisionNumber || !definitionEqual(revision.definition, r.definition as QueryDefinition)) fail('Снимок запроса не соответствует указанной сохранённой версии.');
    return r as unknown as Omit<SearchRun, 'history'>;
  };
  for (const item of p.runs) {
    const r = record(item, 'Выполнение', [...RUN_SNAPSHOT_KEYS, 'history']);
    const { history, ...snapshot } = r;
    const current = validateSnapshot(snapshot, 'Выполнение');
    if (runIds.has(current.id)) fail('Повторяющийся ID выполнения.'); runIds.add(current.id);
    if (!Array.isArray(history)) fail('История исправлений должна быть массивом.');
    for (const item of history) {
      const h = record(item, 'Исправление', ['changedAt', 'reason', 'previous']);
      date(h.changedAt, 'Дата исправления'); text(h.reason, 'Причина исправления', true);
      const previous = validateSnapshot(h.previous, 'Старая редакция выполнения');
      if (previous.id !== current.id || previous.strategyId !== current.strategyId || previous.queryRevisionId !== current.queryRevisionId || previous.strategyTitle !== current.strategyTitle || previous.recordedAt !== current.recordedAt) fail('История исправлений относится к другому выполнению или версии запроса.');
    }
  }
  return clone(value) as Project;
}

export function getStats(project: Project): ProjectStats {
  const total = (key: 'reportedHits' | 'screenedRecords' | 'selectedRecords' | 'exportedRecords'): KnownTotal => {
    const values = project.runs.map(run => run[key]).filter((x): x is number => x !== null);
    return { sum: values.reduce((sum, n) => sum + n, 0), known: values.length, total: project.runs.length };
  };
  // Date-only values are compared at calendar-day precision, without storing an invented time.
  const latest = [...project.runs].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))[0];
  return { strategyCount: project.strategies.length, runCount: project.runs.length, latestExecutedAt: latest?.executedAt ?? null, totals: { reportedHits: total('reportedHits'), screenedRecords: total('screenedRecords'), selectedRecords: total('selectedRecords'), exportedRecords: total('exportedRecords') } };
}
