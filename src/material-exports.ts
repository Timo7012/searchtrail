import { block, csvCell, inline } from './exports';
import { MATERIAL_DECISIONS, MATERIAL_KINDS, READING_STATUSES, type MaterialCatalog } from './materials';

export function materialsToMarkdown(catalog: MaterialCatalog): string {
  const lines = ['## Материалы проекта', '', `Карточек: ${catalog.materials.length}. Это вручную добавленные материалы, а не полный состав выдачи. Счётчики выполнений не пересчитываются.`, ''];
  for (const material of catalog.materials) {
    lines.push(`### ${inline(material.title)}`, '', `ID: ${inline(material.id)}. Тип: ${MATERIAL_KINDS[material.kind]}.`, '',
      `Чтение: ${READING_STATUSES[material.readingStatus]}. Решение: ${MATERIAL_DECISIONS[material.decision]}.`, '');
    for (const [label, value] of [
      ['Авторы / организация', material.authors], ['Год', material.year?.toString() ?? ''],
      ['DOI', material.doi], ['Ссылка', material.url], ['Файл в хранилище', material.filePath],
      ['Заметка в хранилище', material.notePath], ['Причина исключения', material.exclusionReason],
      ['ID запросов', material.strategyIds.join(', ')], ['ID выполнений', material.runIds.join(', ')],
    ]) if (value) lines.push(`- ${label}: ${inline(value)}`);
    lines.push('', 'Заметки:', '', block(material.notes || 'Не указаны.'), '');
    for (const change of material.history) {
      lines.push(`#### Изменение ${inline(change.changedAt)}`, '', 'Предыдущее состояние:', '', block(JSON.stringify(change.previous, null, 2), 'json'), '');
    }
  }
  return lines.join('\n') + '\n';
}

export function materialsToCsv(catalog: MaterialCatalog): string {
  const headers = ['project_id', 'material_id', 'title', 'kind', 'authors', 'year', 'doi', 'url', 'file_path', 'note_path', 'reading_status', 'decision', 'exclusion_reason', 'notes', 'strategy_ids', 'run_ids', 'created_at', 'updated_at', 'changes_count'];
  const rows = catalog.materials.map(m => [catalog.projectId, m.id, m.title, m.kind, m.authors, m.year, m.doi, m.url, m.filePath, m.notePath, m.readingStatus, m.decision, m.exclusionReason, m.notes, JSON.stringify(m.strategyIds), JSON.stringify(m.runIds), m.createdAt, m.updatedAt, m.history.length]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
