import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { createProject, parseProject, type Project, type ProjectInput } from './model';
import { projectToCsv, projectToJson, projectToMarkdown } from './exports';
import type { ExportFormat, ProjectEntry } from './contracts';
import { createProjectDocument, DOCUMENT_SIGNATURE, projectFingerprint, readProjectDocument, updateProjectDocument } from './storage';

export function validateDataFolder(value: string, configDir = '.obsidian'): string {
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('Укажите относительную папку внутри хранилища.');
  const segments = raw.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Путь содержит недопустимое имя папки. Используйте обычные имена без .. и скрытых каталогов.');
  }
  const result = normalizePath(raw);
  const config = normalizePath(configDir);
  if (result === config || result.startsWith(config + '/')) throw new Error('Данные проекта должны храниться вне служебного каталога Obsidian.');
  return result;
}

function slug(title: string): string {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/[. ]+$/g, '').slice(0, 55) || 'project';
}

export class ProjectRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private app: App, private folder: () => string, private onWarning: (message: string) => void) {}

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  getFolder(): string { return validateDataFolder(this.folder(), this.app.vault.configDir); }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing && !(existing instanceof TFolder)) throw new Error(`Вместо папки существует файл: ${current}`);
      if (!existing) {
        try { await this.app.vault.createFolder(current); }
        catch (error) { if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error; }
      }
    }
  }

  private async scanProjects(folder: string): Promise<{ entries: ProjectEntry[]; warnings: string[] }> {
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(folder + '/') && !file.path.startsWith(folder + '/Exports/'));
    const entries: ProjectEntry[] = [];
    const warnings: string[] = [];
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        if (!content.includes(DOCUMENT_SIGNATURE)) continue;
        const project = readProjectDocument(content);
        entries.push({ path: file.path, project, fingerprint: projectFingerprint(project) });
      } catch (error) { warnings.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { entries, warnings };
  }

  async listProjects(): Promise<ProjectEntry[]> {
    const { entries, warnings } = await this.scanProjects(this.getFolder());
    const ids = new Map<string, ProjectEntry[]>();
    for (const entry of entries) ids.set(entry.project.id, [...(ids.get(entry.project.id) || []), entry]);
    for (const copies of ids.values()) {
      if (copies.length > 1) warnings.push(`Повтор ID проекта: ${copies.map(entry => entry.path).join('; ')}. Все копии исключены из панели. Сохраните нужную версию в рабочей папке, остальные переместите в архив вне неё.`);
    }
    if (warnings.length) this.onWarning(warnings.join('\n'));
    return entries.filter(entry => ids.get(entry.project.id)?.length === 1).sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
  }

  async create(input: ProjectInput): Promise<ProjectEntry> { return this.importProject(createProject(input)); }

  async importProject(value: unknown): Promise<ProjectEntry> {
    const project = parseProject(value);
    return this.serialized(async () => {
      const folder = this.getFolder();
      const { entries: existing, warnings } = await this.scanProjects(folder);
      if (warnings.length) this.onWarning(warnings.join('\n'));
      if (existing.some(entry => entry.project.id === project.id)) throw new Error('Проект с таким ID уже существует. Импорт не перезаписал его.');
      if (this.getFolder() !== folder) throw new Error('Папка проектов изменилась во время импорта. Повторите операцию.');
      await this.ensureFolder(folder);
      const safeId = project.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 90);
      if (!safeId) throw new Error('Непригодный ID проекта.');
      const path = normalizePath(`${folder}/search-${slug(project.title)}--${safeId}.md`);
      if (this.getFolder() !== folder) throw new Error('Папка проектов изменилась во время импорта. Повторите операцию.');
      await this.app.vault.create(path, createProjectDocument(project));
      return { path, project, fingerprint: projectFingerprint(project) };
    });
  }

  async save(path: string, expectedRevision: number, next: Project, expectedFingerprint: string): Promise<ProjectEntry> {
    return this.serialized(async () => {
      const folder = this.getFolder();
      if (!path.startsWith(folder + '/')) throw new Error('Проект больше не находится в настроенной папке. Обновите панель.');
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('Файл проекта перемещён или удалён. Обновите панель.');
      const result = await this.app.vault.process(file, text => {
        if (this.getFolder() !== folder) throw new Error('Папка проектов изменилась. Обновите панель.');
        return updateProjectDocument(text, next, expectedRevision, expectedFingerprint);
      });
      const project = readProjectDocument(result);
      return { path, project, fingerprint: projectFingerprint(project) };
    });
  }

  async export(entry: ProjectEntry, format: ExportFormat): Promise<string> {
    return this.serialized(async () => {
      const folder = this.getFolder();
      if (!entry.path.startsWith(folder + '/')) throw new Error('Проект больше не находится в настроенной папке. Обновите панель.');
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (!(file instanceof TFile)) throw new Error('Файл проекта не найден.');
      const project = readProjectDocument(await this.app.vault.read(file));
      const outputFolder = folder + '/Exports';
      await this.ensureFolder(outputFolder);
      const extension = format === 'markdown' ? 'md' : format;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = `${outputFolder}/search-${slug(project.title)}-${stamp}`;
      let path = `${base}.${extension}`;
      let index = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${index++}.${extension}`;
      const content = format === 'csv' ? projectToCsv(project) : format === 'json' ? projectToJson(project) : projectToMarkdown(project);
      if (this.getFolder() !== folder) throw new Error('Папка проектов изменилась во время экспорта. Повторите операцию.');
      await this.app.vault.create(path, content);
      return path;
    });
  }
}
