import { App, Events, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { getAPI } from 'obsidian-local-rest-api';
import { type Project, type ProjectInput } from './model';
import { VIEW_TYPE, type ExportFormat, type ProjectEntry, type SearchHost } from './contracts';
import { ProjectRepository, validateDataFolder } from './repository';
import { ResearchSearchView } from './view';
import { ImportProjectModal, ProjectModal } from './modals';
import { SearchTrailMcp } from './mcp';
import type { MaterialCatalog } from './materials';

interface SearchSettings { dataFolder: string; }
const DEFAULT_SETTINGS: SearchSettings = { dataFolder: 'Search Strategies' };

export default class ResearchSearchPlugin extends Plugin implements SearchHost {
  settings: SearchSettings = { ...DEFAULT_SETTINGS };
  private repository!: ProjectRepository;
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWarning = '';
  private mcp?: SearchTrailMcp;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.repository = new ProjectRepository(this.app, () => this.settings.dataFolder, message => {
      if (message !== this.lastWarning) { this.lastWarning = message; new Notice(message, 12000); }
    });
    this.mcp = new SearchTrailMcp(this, () => getAPI(this.app, this.manifest));
    this.registerEvent((this.app.workspace as Events).on('obsidian-local-rest-api:loaded', () => this.mcp?.connect()));
    this.mcp.connect();
    this.registerView(VIEW_TYPE, leaf => new ResearchSearchView(leaf, this));
    this.addRibbonIcon('search', 'SearchTrail: журнал поисковой стратегии', () => { void this.openView(); });
    this.addCommand({ id: 'open-search-ledger', name: 'Открыть журнал поиска', callback: () => { void this.openView(); } });
    this.addCommand({ id: 'create-search-project', name: 'Создать поисковый проект', callback: () => {
      new ProjectModal(this, undefined, () => { void this.openView(); }).open();
    }});
    this.addCommand({ id: 'import-search-project', name: 'Импортировать проект из JSON', callback: () => {
      new ImportProjectModal(this.app, async value => {
        const entry = await this.importProject(value);
        new Notice(`Импортирован проект «${entry.project.title}».`);
        await this.openView();
      }).open();
    }});
    this.addSettingTab(new SearchSettingsTab(this.app, this));

    const changed = (path: string) => {
      const prefix = this.settings.dataFolder + '/';
      if (path.startsWith(prefix) && path.endsWith('.md') && !path.startsWith(prefix + 'Exports/')) this.notify();
    };
    this.registerEvent(this.app.vault.on('modify', file => changed(file.path)));
    this.registerEvent(this.app.vault.on('create', file => changed(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => changed(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { changed(file.path); changed(oldPath); }));
  }

  onunload(): void {
    this.mcp?.disconnect();
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.listeners.clear();
  }

  private async loadSettings(): Promise<void> {
    const value: unknown = await this.loadData();
    if (value && typeof value === 'object' && 'dataFolder' in value && typeof value.dataFolder === 'string') {
      try { this.settings.dataFolder = validateDataFolder(value.dataFolder, this.app.vault.configDir); }
      catch (error) { new Notice(`Настройка папки не прочитана: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  async setDataFolder(value: string): Promise<void> {
    const folder = validateDataFolder(value, this.app.vault.configDir);
    const before = this.settings;
    this.settings = { dataFolder: folder };
    try { await this.saveData(this.settings); }
    catch (error) { this.settings = before; throw error; }
    this.lastWarning = '';
    this.notify();
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.notify();
  }

  getDataFolder(): string { return this.settings.dataFolder; }
  listProjects(): Promise<ProjectEntry[]> { return this.repository.listProjects(); }
  getMcpStatus(): string { return this.mcp?.status ?? 'MCP не инициализирован.'; }
  async saveMaterials(entry: ProjectEntry, catalog: MaterialCatalog): Promise<ProjectEntry> {
    const saved = await this.repository.saveMaterials(entry, catalog);
    this.notify();
    return saved;
  }
  async importProject(value: unknown): Promise<ProjectEntry> {
    const entry = await this.repository.importProject(value);
    this.notify();
    return entry;
  }
  async createProject(input: ProjectInput): Promise<ProjectEntry> {
    const entry = await this.repository.create(input);
    this.notify();
    return entry;
  }
  async saveProject(path: string, expectedRevision: number, next: Project, expectedFingerprint: string): Promise<ProjectEntry> {
    const entry = await this.repository.save(path, expectedRevision, next, expectedFingerprint);
    this.notify();
    return entry;
  }
  exportProject(entry: ProjectEntry, format: ExportFormat): Promise<string> { return this.repository.export(entry, format); }

  async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Файл не найден: ${path}`);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      for (const listener of this.listeners) {
        try { listener(); } catch (error) { console.error('SearchTrail view refresh failed', error); }
      }
    }, 120);
  }

  private async openView(): Promise<void> {
    try {
      let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) { new Notice(`Не удалось открыть журнал: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

class SearchSettingsTab extends PluginSettingTab {
  constructor(app: App, private searchPlugin: ResearchSearchPlugin) { super(app, searchPlugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'SearchTrail' });
    containerEl.createEl('p', { text: this.searchPlugin.getMcpStatus() });
    containerEl.createEl('p', { text: 'Проекты сохраняются в Markdown-файлах внутри хранилища. Настройка папки не переносит существующие проекты.' });
    let path = this.searchPlugin.getDataFolder();
    new Setting(containerEl).setName('Папка проектов').setDesc('Относительно корня хранилища. Экспорты помещаются в подпапку Exports.').addText(text => {
      text.setValue(path).onChange(value => { path = value; });
      text.inputEl.style.width = '100%';
    }).addButton(button => button.setButtonText('Применить').setCta().onClick(async () => {
      button.setDisabled(true);
      try { await this.searchPlugin.setDataFolder(path); new Notice('Папка проектов сохранена.'); this.display(); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      finally { button.setDisabled(false); }
    }));
    containerEl.createEl('p', { text: 'Исходные запросы и история хранятся локально. Плагин не выполняет поисковые запросы и не подключается к аккаунту Zotero.' });
  }
}
