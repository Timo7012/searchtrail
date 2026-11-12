import { parseProject, type Project } from './model';
import { projectToJson, projectToMarkdown } from './exports';

export const DOCUMENT_SIGNATURE = '<!-- research-search-project:v1 -->';
const DATA_START = '<!-- research-search:data:start -->';
const DATA_END = '<!-- research-search:data:end -->';
const REPORT_START = '<!-- research-search:report:start -->';
const REPORT_END = '<!-- research-search:report:end -->';

function markerPosition(text: string, marker: string): { start: number; end: number } {
  const matches: { start: number; end: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (content === marker) matches.push({ start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  if (matches.length !== 1) {
    throw new Error(`Повреждена структура файла: маркер «${marker}» должен встречаться один раз. Файл не изменён.`);
  }
  return matches[0];
}

function blockPositions(text: string, startMarker: string, endMarker: string) {
  const start = markerPosition(text, startMarker);
  const end = markerPosition(text, endMarker);
  if (start.end >= end.start) throw new Error('Неверный порядок блоков проекта. Файл не изменён.');
  return { start, end };
}

function replaceBlock(text: string, startMarker: string, endMarker: string, body: string): string {
  const { start, end } = blockPositions(text, startMarker, endMarker);
  return text.slice(0, start.end) + '\n' + body + '\n' + text.slice(end.start);
}

function reportBody(project: Project): string {
  // The human-readable report must never introduce structural marker lines.
  return projectToMarkdown(project).replaceAll('<!-- research-search:', '&lt;!-- research-search:').replaceAll(DOCUMENT_SIGNATURE, '&lt;!-- research-search-project:v1 -->');
}

function dataBody(project: Project): string {
  const json = projectToJson(project).trimEnd().replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return '```json\n' + json + '\n```';
}

export function projectFingerprint(project: Project): string {
  // Exact comparison also catches edits made outside the plugin without a revision bump.
  return JSON.stringify(project);
}

export function readProjectDocument(text: string): Project {
  markerPosition(text, DOCUMENT_SIGNATURE);
  const data = blockPositions(text, DATA_START, DATA_END);
  const report = blockPositions(text, REPORT_START, REPORT_END);
  if (!(report.end.end <= data.start.start || data.end.end <= report.start.start)) {
    throw new Error('Управляемые блоки проекта пересекаются. Файл не изменён.');
  }
  const block = text.slice(data.start.end, data.end.start).trim();
  const match = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(block);
  if (!match) throw new Error('Не найден JSON-блок проекта. Файл не изменён.');
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { throw new Error('JSON проекта повреждён. Исправьте или восстановите файл; он не был перезаписан.'); }
  return parseProject(value);
}

export function createProjectDocument(project: Project): string {
  const validated = parseProject(project);
  return [
    '---',
    'type: research-search-project',
    `project_id: ${JSON.stringify(validated.id)}`,
    '---', '', DOCUMENT_SIGNATURE, '',
    REPORT_START, reportBody(validated).trimEnd(), REPORT_END, '',
    '## Собственные заметки', '',
    'Здесь можно писать свободный текст. Плагин сохраняет текст вне своих управляемых блоков.', '',
    DATA_START, dataBody(validated), DATA_END, ''
  ].join('\n');
}

export function updateProjectDocument(text: string, next: Project, expectedRevision: number, expectedFingerprint: string): string {
  const current = readProjectDocument(text);
  const validated = parseProject(next);
  if (current.revision !== expectedRevision || projectFingerprint(current) !== expectedFingerprint) {
    throw new Error('Проект изменён в другой вкладке или на другом устройстве. Обновите панель и откройте форму заново. Ваши изменения в форме не записаны.');
  }
  if (validated.id !== current.id || validated.revision !== current.revision + 1) {
    throw new Error('Несогласованная версия проекта. Файл не изменён.');
  }
  let result = replaceBlock(text, DATA_START, DATA_END, dataBody(validated));
  result = replaceBlock(result, REPORT_START, REPORT_END, reportBody(validated).trimEnd());
  return result;
}
