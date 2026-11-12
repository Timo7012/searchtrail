import type { LocalRestApiPublicApi, McpToolDefinition } from 'obsidian-local-rest-api';
import { z } from 'zod';
import type { SearchHost, ProjectEntry } from './contracts';
import {
  addRun, addStrategy, editProject, editRun, editStrategy, getStats,
  type Project, type ProjectInput, type RunInput, type StrategyInput,
} from './model';
import { addMaterial, editMaterial, emptyCatalog, type MaterialCatalog } from './materials';

export type McpHost = Pick<SearchHost, 'listProjects' | 'createProject' | 'saveProject' | 'exportProject' | 'saveMaterials'> & {
  importProject(value: unknown): Promise<ProjectEntry>;
};

const text = z.string();
const id = z.string().min(1);
const projectInput = z.object({ title: id, question: text, criteria: text, deduplicationNotes: text }).strict();
const definition = z.object({
  database: id, platform: id, query: id, searchFields: text, filters: text,
  publicationRange: text, languages: text, searchUrl: text,
}).strict();
const strategyInput = z.object({
  title: id, status: z.enum(['draft', 'active', 'paused', 'done']), definition, changeNote: text,
}).strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const runInput = z.object({
  purpose: z.enum(['pilot', 'main', 'update']), status: z.enum(['completed', 'partial', 'failed']),
  executedAt: id, timeZone: text, reportedHits: count, reportedHitsApproximate: z.boolean(),
  screenedRecords: count, selectedRecords: count, exportedRecords: count,
  durationMinutes: z.number().finite().nonnegative().nullable(),
  resultUrl: text, exportPath: text, zoteroLink: text, notes: text,
}).strict();
const selection = { projectId: id };
const precondition = {
  ...selection,
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedFingerprint: id.describe('Точный fingerprint из последнего чтения проекта. Не вычисляйте его самостоятельно.'),
};
const materialInput = z.object({
  title: id,
  kind: z.enum(['article', 'documentation', 'report', 'webpage', 'book', 'video', 'other']).default('other'),
  authors: text.default(''), year: z.number().int().min(1).max(9999).nullable().default(null),
  doi: text.default(''), url: text.default(''), filePath: text.default(''), notePath: text.default(''),
  readingStatus: z.enum(['unread', 'reading', 'read']).default('unread'),
  decision: z.enum(['undecided', 'selected', 'excluded']).default('undecided'),
  exclusionReason: text.default(''), notes: text.default(''), strategyIds: z.array(id).default([]), runIds: z.array(id).default([]),
}).strict();
const catalogPrecondition = { ...precondition, expectedCatalogFingerprint: text.nullable().describe('catalogFingerprint из get_project или null, если каталог ещё отсутствует.') };
const materialEditInput = z.object({
  title: id, kind: materialInput.shape.kind.removeDefault(), authors: text,
  year: materialInput.shape.year.removeDefault(), doi: text, url: text, filePath: text, notePath: text,
  readingStatus: materialInput.shape.readingStatus.removeDefault(), decision: materialInput.shape.decision.removeDefault(),
  exclusionReason: text, notes: text, strategyIds: z.array(id), runIds: z.array(id),
}).strict();

/** Domain operations shared with forms; MCP never writes managed Markdown directly. */
export function createSearchTrailTools(host: McpHost): McpToolDefinition[] {
  async function find(projectId: string): Promise<ProjectEntry> {
    const entries = await host.listProjects();
    const matches = entries.filter(entry => entry.project.id === projectId);
    if (matches.length !== 1) throw new Error('Проект не найден или его ID неоднозначен. Перечитайте список проектов и проверьте предупреждения SearchTrail.');
    return matches[0];
  }

  async function change(
    args: { projectId: string; expectedRevision: number; expectedFingerprint: string },
    update: (project: Project) => Project,
  ): Promise<ProjectEntry> {
    const entry = await find(args.projectId);
    if (entry.project.revision !== args.expectedRevision || entry.fingerprint !== args.expectedFingerprint) {
      throw new Error('Проект изменён после чтения. Перечитайте его перед повторным изменением.');
    }
    return host.saveProject(entry.path, args.expectedRevision, update(entry.project), args.expectedFingerprint);
  }

  async function changeMaterials(
    args: { projectId: string; expectedRevision: number; expectedFingerprint: string; expectedCatalogFingerprint: string | null },
    update: (entry: ProjectEntry, catalog: MaterialCatalog) => MaterialCatalog,
  ): Promise<ProjectEntry> {
    const entry = await find(args.projectId);
    if (entry.project.revision !== args.expectedRevision || entry.fingerprint !== args.expectedFingerprint
      || (entry.catalogFingerprint ?? null) !== args.expectedCatalogFingerprint) throw new Error('Проект или материалы изменены. Перечитайте проект перед повторной записью.');
    return host.saveMaterials(entry, update(entry, entry.catalog ?? emptyCatalog(entry.project.id)));
  }

  function tool<S extends z.ZodRawShape>(
    name: string, description: string, shape: S, readOnly: boolean,
    execute: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): McpToolDefinition {
    // Validate again in the callback: the transport must not be the only boundary.
    const schema = z.object(shape).strict();
    return {
      name: `searchtrail_${name}`, description, inputSchema: shape,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      callback: async args => {
        try {
          const value = await execute(schema.parse(args));
          return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    };
  }

  const fullInput = 'Передайте полное определение input, включая пустые строки и null. Неизвестные поля запрещены.';
  const guarded = 'Сначала прочитайте проект; передайте его expectedRevision и expectedFingerprint. При конфликте перечитайте проект, не повторяйте запись вслепую.';
  return [
    tool('list_projects', 'Список проектов SearchTrail из настроенной папки, без полных запросов и истории. limit/offset ограничивают ответ.', {
      limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0),
    }, true, async ({ limit, offset }) => {
      const entries = await host.listProjects();
      return {
        total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null,
        projects: entries.slice(offset, offset + limit).map(({ path, project }) => ({
          path, id: project.id, title: project.title, revision: project.revision,
          updatedAt: project.updatedAt, strategyCount: project.strategies.length, runCount: project.runs.length,
        })),
      };
    }),
    tool('get_project', 'Полный проект SearchTrail: версии, снимки выполнений, история исправлений, revision и fingerprint для последующих изменений.', selection, true,
      async ({ projectId }) => find(projectId)),
    tool('create_project', `Создать проект SearchTrail. ${fullInput}`, { input: projectInput }, false,
      async ({ input }) => host.createProject(input as ProjectInput)),
    tool('edit_project', `Изменить поля проекта, сохраняя запросы и выполнения. ${fullInput} ${guarded}`, { ...precondition, input: projectInput }, false,
      async args => change(args, project => editProject(project, args.input as ProjectInput))),
    tool('add_strategy', `Добавить поисковый запрос и его первую версию. ${fullInput} ${guarded}`, { ...precondition, input: strategyInput }, false,
      async args => change(args, project => addStrategy(project, args.input as StrategyInput))),
    tool('edit_strategy', `Изменить запрос. Изменение определения создаёт новую версию и сохраняет снимки прошлых выполнений. ${fullInput} ${guarded}`, { ...precondition, strategyId: id, input: strategyInput }, false,
      async args => change(args, project => editStrategy(project, args.strategyId, args.input as StrategyInput))),
    tool('add_run', `Записать выполнение выбранной сохранённой версии запроса (queryRevisionId); точный снимок создаётся внутри SearchTrail. null означает неизвестно, 0 означает известный ноль. ${fullInput} ${guarded}`, {
      ...precondition, strategyId: id, queryRevisionId: id, input: runInput,
    }, false, async args => change(args, project => addRun(project, args.strategyId, args.queryRevisionId, args.input as RunInput))),
    tool('correct_run', `Исправить выполнение с обязательной причиной reason и сохранением прошлого состояния в истории. Версия запроса и снимок остаются прежними. ${fullInput} ${guarded}`, {
      ...precondition, runId: id, reason: text.trim().min(1), input: runInput,
    }, false, async args => change(args, project => editRun(project, args.runId, args.input as RunInput, args.reason))),
    tool('get_stats', 'Сводка по всем выполнениям проекта, включая пробные и частичные. Суммы могут включать повторы и не равны числу уникальных публикаций. known/total показывают заполненность.', selection, true,
      async ({ projectId }) => ({ scope: 'all_project_runs', stats: getStats((await find(projectId)).project) })),
    tool('export_project', 'Создать новый экспорт всего проекта в подпапке Exports. json содержит полный перенос с историей; csv содержит текущие состояния выполнений. Старые экспорты сохраняются.', {
      ...selection, format: z.enum(['markdown', 'csv', 'json', 'materials-csv']),
    }, false, async ({ projectId, format }) => ({ path: await host.exportProject(await find(projectId), format) })),
    tool('import_project', 'Импортировать полный JSON-экспорт SearchTrail, сохранив ID, версии и историю. Существующий ID отвергается; объединение историй не выполняется.', {
      project: z.record(z.unknown()),
    }, false, async ({ project }) => host.importProject(project)),
    tool('list_materials', 'Список вручную добавленных материалов проекта. DOI и библиографические поля необязательны; число карточек не заменяет статистику выполнений. Чтение полного проекта возвращает catalog и catalogFingerprint.', {
      ...selection, limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0),
    }, true, async ({ projectId, limit, offset }) => {
      const entry = await find(projectId), materials = entry.catalog?.materials ?? [];
      return { total: materials.length, nextOffset: offset + limit < materials.length ? offset + limit : null, materials: materials.slice(offset, offset + limit) };
    }),
    tool('add_material', `Добавить материал: статью, документацию, отчёт или веб-страницу. В input обязательно только title. Связи strategyIds/runIds необязательны, могут содержать несколько ID. При исключении обязательна exclusionReason. ${guarded} Дополнительно передайте expectedCatalogFingerprint из чтения проекта или null.`, {
      ...catalogPrecondition, input: materialInput,
    }, false, async args => changeMaterials(args, (entry, catalog) => addMaterial(catalog, entry.project, args.input))),
    tool('edit_material', `Изменить материал с сохранением прежнего состояния в истории. Передайте полный input со всеми необязательными значениями из прочитанной карточки, исключая id, даты и history. ${guarded} Дополнительно передайте expectedCatalogFingerprint.`, {
      ...catalogPrecondition, materialId: id, input: materialEditInput,
    }, false, async args => changeMaterials(args, (entry, catalog) => editMaterial(catalog, entry.project, args.materialId, args.input))),
  ];
}

export type McpExtensionApi = Pick<LocalRestApiPublicApi, 'apiVersion' | 'addMcpTool' | 'unregister'>;

/** Reconnect on each host load; callbacks from old handles cannot keep writing. */
export class SearchTrailMcp {
  private api?: McpExtensionApi;
  private generation = 0;
  status = 'Ожидание Local REST API with MCP.';

  constructor(private host: McpHost, private resolve: () => McpExtensionApi | undefined) {}

  connect(): void {
    this.disconnect();
    let api: McpExtensionApi | undefined;
    try {
      api = this.resolve();
      if (!api) { this.status = 'Local REST API with MCP не загружен. SearchTrail работает без MCP.'; return; }
      if ((api.apiVersion ?? 1) < 3) throw new Error('Нужен Local REST API with MCP с extension API версии 3 или новее.');
      const generation = this.generation;
      const definitions = createSearchTrailTools(this.host);
      for (const definition of definitions) {
        const callback = definition.callback;
        api.addMcpTool({ ...definition, callback: async args => {
          if (generation !== this.generation) return { isError: true, content: [{ type: 'text', text: 'MCP-подключение SearchTrail закрыто. Обновите список инструментов.' }] };
          return callback(args);
        } });
      }
      this.api = api;
      this.status = `MCP подключён: ${definitions.length} инструментов SearchTrail.`;
    } catch (error) {
      this.generation += 1;
      try { api?.unregister(); } catch { /* The host may have already unloaded. */ }
      this.status = `MCP недоступен: ${error instanceof Error ? error.message : String(error)}`;
      console.error('SearchTrail MCP registration failed', error);
    }
  }

  disconnect(): void {
    this.generation += 1;
    const api = this.api;
    this.api = undefined;
    try { api?.unregister(); } catch { /* An unloaded host owns no live tools. */ }
    this.status = 'MCP отключён.';
  }
}
