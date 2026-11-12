import type { Project } from './model';

export type MaterialKind = 'article' | 'documentation' | 'report' | 'webpage' | 'book' | 'video' | 'other';
export type ReadingStatus = 'unread' | 'reading' | 'read';
export type MaterialDecision = 'undecided' | 'selected' | 'excluded';
export interface MaterialInput {
  title: string;
  kind: MaterialKind;
  authors: string;
  year: number | null;
  doi: string;
  url: string;
  filePath: string;
  notePath: string;
  readingStatus: ReadingStatus;
  decision: MaterialDecision;
  exclusionReason: string;
  notes: string;
  strategyIds: string[];
  runIds: string[];
}
export interface Material extends MaterialInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{ changedAt: string; previous: Omit<Material, 'history'> }>;
}
export interface MaterialCatalog {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  materials: Material[];
}

export const MATERIAL_KINDS: Record<MaterialKind, string> = {
  article: 'Статья', documentation: 'Документация', report: 'Отчёт', webpage: 'Веб-страница',
  book: 'Книга', video: 'Видео', other: 'Другое',
};
export const READING_STATUSES: Record<ReadingStatus, string> = { unread: 'Не просмотрен', reading: 'В работе', read: 'Просмотрен' };
export const MATERIAL_DECISIONS: Record<MaterialDecision, string> = { undecided: 'Решение не принято', selected: 'Отобран', excluded: 'Исключён' };
const INPUT_KEYS = ['title', 'kind', 'authors', 'year', 'doi', 'url', 'filePath', 'notePath', 'readingStatus', 'decision', 'exclusionReason', 'notes', 'strategyIds', 'runIds'];
const SNAPSHOT_KEYS = [...INPUT_KEYS, 'id', 'createdAt', 'updatedAt'];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  const item = value as Record<string, unknown>;
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(item, key)) || Object.keys(item).some(key => !keys.includes(key))) {
    throw new Error(`${label}: отсутствуют обязательные или присутствуют неизвестные поля. Данные не изменены.`);
  }
  return item;
}
function text(value: unknown, label: string, required = false): asserts value is string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`${label}: ${required ? 'заполните текстовое поле' : 'ожидается текст'}.`);
}
function timestamp(value: unknown): void {
  text(value, 'Дата материала', true);
  const match = /^(\d{4}-\d{2}-\d{2})T([0-2]\d):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || Number(match[2]) > 23 || !Number.isFinite(Date.parse(value))
    || new Date(match[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== match[1]) throw new Error('Некорректная дата материала.');
}
export function validateMaterialPath(value: string, configDir = '.obsidian'): void {
  if (!value) return;
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (/^[a-zA-Z]:/.test(value) || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f]/.test(part))
    || normalized.toLocaleLowerCase() === configDir.toLocaleLowerCase() || normalized.toLocaleLowerCase().startsWith(configDir.toLocaleLowerCase() + '/')) {
    throw new Error('Файл и заметка материала должны иметь относительные пути внутри хранилища, вне каталога конфигурации.');
  }
}
function validateInput(value: unknown, project: Project): asserts value is MaterialInput {
  const item = object(value, INPUT_KEYS, 'Материал');
  for (const key of ['title', 'authors', 'doi', 'url', 'filePath', 'notePath', 'exclusionReason', 'notes']) text(item[key], key, key === 'title');
  if (typeof item.kind !== 'string' || typeof item.readingStatus !== 'string' || typeof item.decision !== 'string'
    || !Object.prototype.hasOwnProperty.call(MATERIAL_KINDS, item.kind) || !Object.prototype.hasOwnProperty.call(READING_STATUSES, item.readingStatus) || !Object.prototype.hasOwnProperty.call(MATERIAL_DECISIONS, item.decision)) throw new Error('Неизвестный тип или статус материала.');
  if (item.year !== null && (typeof item.year !== 'number' || !Number.isSafeInteger(item.year) || item.year < 1 || item.year > 9999)) throw new Error('Год: укажите целое число от 1 до 9999 или оставьте поле пустым.');
  if (item.doi && !/^10\.\d{4,9}\/\S+$/i.test(item.doi as string)) throw new Error('DOI необязателен. Если он указан, используйте идентификатор вида 10.1234/example.');
  if (item.url) {
    let url: URL;
    try { url = new URL(item.url as string); } catch { throw new Error('Ссылка материала: введите полный HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ссылка материала: допускаются только HTTP(S) URL.');
  }
  validateMaterialPath(item.filePath as string); validateMaterialPath(item.notePath as string);
  if (item.decision === 'excluded' && !(item.exclusionReason as string).trim()) throw new Error('Укажите причину исключения материала.');
  for (const [key, allowed] of [['strategyIds', project.strategies.map(s => s.id)], ['runIds', project.runs.map(r => r.id)]] as const) {
    const ids = item[key];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !allowed.includes(id)) || new Set(ids).size !== ids.length) throw new Error('Связи материала с запросами или выполнениями повреждены.');
  }
}

export function emptyMaterial(): MaterialInput {
  return { title: '', kind: 'other', authors: '', year: null, doi: '', url: '', filePath: '', notePath: '', readingStatus: 'unread', decision: 'undecided', exclusionReason: '', notes: '', strategyIds: [], runIds: [] };
}
export function emptyCatalog(projectId: string): MaterialCatalog {
  return { schemaVersion: 1, projectId, revision: 0, materials: [] };
}
export function parseMaterialCatalog(value: unknown, project: Project): MaterialCatalog {
  const catalog = object(value, ['schemaVersion', 'projectId', 'revision', 'materials'], 'Каталог материалов');
  if (catalog.schemaVersion !== 1) throw new Error('Неподдерживаемая версия каталога материалов. Данные не изменены.');
  if (catalog.projectId !== project.id) throw new Error('Каталог материалов относится к другому проекту.');
  if (typeof catalog.revision !== 'number' || !Number.isSafeInteger(catalog.revision) || catalog.revision < 0 || !Array.isArray(catalog.materials)) throw new Error('Повреждена редакция или список материалов.');
  if (catalog.revision === 0 && catalog.materials.length) throw new Error('Несогласованная редакция каталога материалов.');
  const ids = new Set<string>();
  const snapshot = (value: unknown) => {
    const item = object(value, SNAPSHOT_KEYS, 'Запись материала');
    validateInput(Object.fromEntries(INPUT_KEYS.map(key => [key, item[key]])), project);
    text(item.id, 'ID материала', true); timestamp(item.createdAt); timestamp(item.updatedAt);
    return item as unknown as Omit<Material, 'history'>;
  };
  for (const value of catalog.materials) {
    const item = object(value, [...SNAPSHOT_KEYS, 'history'], 'Материал');
    const { history, ...body } = item;
    const current = snapshot(body);
    if (ids.has(current.id)) throw new Error('Повтор ID материала.');
    ids.add(current.id);
    if (!Array.isArray(history)) throw new Error('История материала должна быть массивом.');
    for (const value of history) {
      const change = object(value, ['changedAt', 'previous'], 'Изменение материала');
      timestamp(change.changedAt);
      const previous = snapshot(change.previous);
      if (previous.id !== current.id || previous.createdAt !== current.createdAt) throw new Error('История относится к другому материалу.');
    }
  }
  return clone(value) as MaterialCatalog;
}
export function addMaterial(catalog: MaterialCatalog, project: Project, input: MaterialInput): MaterialCatalog {
  parseMaterialCatalog(catalog, project); validateInput(input, project);
  const next = clone(catalog), at = new Date().toISOString();
  next.revision++;
  next.materials.push({ ...clone(input), title: input.title.trim(), filePath: input.filePath.replace(/\\/g, '/'), notePath: input.notePath.replace(/\\/g, '/'), id: crypto.randomUUID(), createdAt: at, updatedAt: at, history: [] });
  return next;
}
export function editMaterial(catalog: MaterialCatalog, project: Project, materialId: string, input: MaterialInput): MaterialCatalog {
  parseMaterialCatalog(catalog, project); validateInput(input, project);
  const next = clone(catalog), index = next.materials.findIndex(item => item.id === materialId);
  if (index < 0) throw new Error('Материал не найден. Обновите проект.');
  const { history, ...previous } = next.materials[index];
  const at = new Date().toISOString();
  next.revision++;
  next.materials[index] = { ...previous, ...clone(input), title: input.title.trim(), filePath: input.filePath.replace(/\\/g, '/'), notePath: input.notePath.replace(/\\/g, '/'), updatedAt: at, history: [...history, { changedAt: at, previous }] };
  return next;
}
export function materialInput(material: Material): MaterialInput {
  return clone(Object.fromEntries(INPUT_KEYS.map(key => [key, material[key as keyof Material]]))) as unknown as MaterialInput;
}
