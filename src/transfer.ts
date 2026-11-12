import { parseProject, type Project } from './model';
import { parseMaterialCatalog, type MaterialCatalog } from './materials';
import { projectToJson } from './exports';

export interface ProjectTransfer { project: Project; catalog?: MaterialCatalog; }

/** Legacy v1 JSON stays unchanged. Catalogs use an explicit transfer envelope. */
export function parseProjectTransfer(value: unknown): ProjectTransfer {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'format' in value) {
    const bundle = value as Record<string, unknown>;
    const keys = ['format', 'transferVersion', 'project', 'catalog'];
    if (bundle.format !== 'searchtrail-project' || bundle.transferVersion !== 1
      || keys.some(key => !Object.prototype.hasOwnProperty.call(bundle, key)) || Object.keys(bundle).some(key => !keys.includes(key))) {
      throw new Error('Неподдерживаемый или повреждённый формат переноса SearchTrail. Данные не изменены.');
    }
    const project = parseProject(bundle.project);
    return { project, catalog: parseMaterialCatalog(bundle.catalog, project) };
  }
  return { project: parseProject(value) };
}

export function projectTransferToJson(project: Project, catalog?: MaterialCatalog): string {
  const validated = parseProject(project);
  return catalog ? JSON.stringify({ format: 'searchtrail-project', transferVersion: 1, project: validated, catalog: parseMaterialCatalog(catalog, validated) }, null, 2) + '\n' : projectToJson(validated);
}
