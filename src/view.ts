import { ItemView, Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import { getStats, lastRevision, type KnownTotal, type RunInput, type SearchRun, type Strategy, type StrategyStatus } from './model';
import { VIEW_TYPE, type ExportFormat, type ProjectEntry, type SearchHost } from './contracts';
import {
  ImportProjectModal, MaterialModal, ProjectModal, StrategyModal, RunModal, RevisionHistoryModal,
  STRATEGY_LABELS, PURPOSE_LABELS, RUN_STATUS_LABELS,
  copyQuery, countText, displayDate, displaySearchDate, renderDefinition,
} from './modals';
import { MATERIAL_DECISIONS, MATERIAL_KINDS, READING_STATUSES, type Material } from './materials';

type Tab = 'strategies' | 'journal' | 'materials';
interface Filters {
  text: string;
  platform: string;
  strategyStatus: StrategyStatus | '';
  purpose: RunInput['purpose'] | '';
  runStatus: RunInput['status'] | '';
  strategyId: string;
  dateFrom: string;
  dateTo: string;
  materialKind: string;
  readingStatus: string;
  materialDecision: string;
  materialRunId: string;
}

const emptyFilters = (): Filters => ({
  text: '', platform: '', strategyStatus: '', purpose: '', runStatus: '',
  strategyId: '', dateFrom: '', dateTo: '', materialKind: '', readingStatus: '', materialDecision: '', materialRunId: '',
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function button(parent: HTMLElement, label: string, action: () => void, primary = false): HTMLButtonElement {
  const el = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}

function labelInput(parent: HTMLElement, label: string, type = 'text'): HTMLInputElement {
  const wrapper = parent.createEl('label', { cls: 'rss-filter' });
  wrapper.createEl('span', { text: label });
  const input = wrapper.createEl('input', { type });
  input.setAttribute('aria-label', label);
  return input;
}

function labelSelect(parent: HTMLElement, label: string): HTMLSelectElement {
  const wrapper = parent.createEl('label', { cls: 'rss-filter' });
  wrapper.createEl('span', { text: label });
  const select = wrapper.createEl('select');
  select.setAttribute('aria-label', label);
  return select;
}

function options(select: HTMLSelectElement, items: Array<[string, string]>, value: string): void {
  select.empty();
  for (const [key, text] of items) select.createEl('option', { value: key, text });
  select.value = value;
}

function searchText(parts: string[]): string {
  return parts.join('\n').toLocaleLowerCase('ru-RU');
}

function safeLink(parent: HTMLElement, label: string, value: string, zotero = false): void {
  if (!value) return;
  try {
    const parsed = new URL(value);
    const allowed = zotero ? ['https:', 'http:', 'zotero:'] : ['https:', 'http:'];
    if (!allowed.includes(parsed.protocol)) return;
    const link = parent.createEl('a', { text: label, href: value });
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('title', value);
  } catch { /* Imported invalid links are never made executable. */ }
}

export class ResearchSearchView extends ItemView {
  private projectMenu?: Menu;
  private entries: ProjectEntry[] = [];
  private selectedId = '';
  private renderedId = '';
  private activeTab: Tab = 'strategies';
  private focusedStrategyId = '';
  private detailDecision = '';
  private detailRunLimit = 50;
  private filters = emptyFilters();
  private unsubscribe?: () => void;
  private opened = false;
  private loadSequence = 0;
  private runLimit = 50;
  private exporting = false;

  private picker!: HTMLSelectElement;
  private projectArea!: HTMLElement;
  private feedback!: HTMLElement;
  private overview!: HTMLElement;
  private statsEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private results!: HTMLElement;
  private resultsCount!: HTMLElement;
  private filterFeedback!: HTMLElement;
  private filtersEl!: HTMLElement;
  private textInput!: HTMLInputElement;
  private platformSelect!: HTMLSelectElement;
  private strategyStatusSelect!: HTMLSelectElement;
  private purposeSelect!: HTMLSelectElement;
  private runStatusSelect!: HTMLSelectElement;
  private strategySelect!: HTMLSelectElement;
  private dateFromInput!: HTMLInputElement;
  private dateToInput!: HTMLInputElement;
  private strategyFilterRow!: HTMLElement;
  private journalFilterRow!: HTMLElement;
  private strategyTab!: HTMLButtonElement;
  private journalTab!: HTMLButtonElement;
  private materialsTab!: HTMLButtonElement;
  private materialFilterRow!: HTMLElement;
  private materialKindSelect!: HTMLSelectElement;
  private materialReadingSelect!: HTMLSelectElement;
  private materialDecisionSelect!: HTMLSelectElement;
  private materialRunSelect!: HTMLSelectElement;
  private addButton!: HTMLButtonElement;
  private exportButton!: HTMLButtonElement;
  private exportSelect!: HTMLSelectElement;

  constructor(leaf: WorkspaceLeaf, private readonly host: SearchHost) { super(leaf); }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'SearchTrail'; }
  getIcon(): string { return 'search-check'; }

  protected async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.empty();
    this.renderedId = '';
    this.contentEl.addClass('rss-view');
    const top = this.contentEl.createDiv({ cls: 'rss-topbar' });
    const brand = top.createDiv();
    brand.createDiv({ cls: 'rss-eyebrow', text: 'SearchTrail' });
    brand.createEl('h1', { text: 'Поисковая стратегия' });
    brand.createEl('p', { cls: 'rss-muted', text: 'Запросы, журнал поиска и материалы для исследований и работы' });
    const actions = top.createDiv({ cls: 'rss-actions' });
    button(actions, 'Обновить', () => { void this.refreshProjects(); });
    this.projectMenuButton(actions, 'Новый проект');
    const projectPicker = this.contentEl.createDiv({ cls: 'rss-project-picker' });
    this.picker = labelSelect(projectPicker, 'Поисковый проект');
    this.picker.addEventListener('change', () => {
      this.selectedId = this.picker.value;
      this.focusedStrategyId = '';
      this.filters = emptyFilters();
      this.runLimit = 50;
      this.renderProject(true);
    });
    this.feedback = this.contentEl.createDiv({ cls: 'rss-feedback' });
    this.feedback.setAttribute('role', 'status');
    this.feedback.hidden = true;
    this.projectArea = this.contentEl.createDiv({ cls: 'rss-project-area' });
    this.projectArea.createEl('p', { cls: 'rss-muted', text: 'Загрузка проектов…' });
    this.unsubscribe = this.host.subscribe(() => { void this.refreshProjects(); });
    await this.refreshProjects();
  }

  protected async onClose(): Promise<void> {
    this.projectMenu?.hide();
    this.opened = false;
    this.loadSequence += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  private get entry(): ProjectEntry | undefined {
    return this.entries.find(item => item.project.id === this.selectedId);
  }

  private afterSaved = (entry: ProjectEntry): void => {
    this.selectedId = entry.project.id;
    void this.refreshProjects();
  };

  private newProject(): void { new ProjectModal(this.host, undefined, this.afterSaved).open(); }

  private importProject(): void {
    new ImportProjectModal(this.app, async project => {
      const entry = await this.host.importProject(project);
      this.afterSaved(entry);
      new Notice(`Импортирован проект «${entry.project.title}».`);
    }).open();
  }

  private projectMenuButton(parent: HTMLElement, label: string, primary = false): void {
    const trigger = button(parent, label, () => {
      this.projectMenu?.hide();
      const menu = new Menu();
      this.projectMenu = menu;
      menu.addItem(item => item.setTitle('Создать пустой проект').setIcon('plus').onClick(() => this.newProject()));
      menu.addItem(item => item.setTitle('Импортировать из JSON').setIcon('file-input').onClick(() => this.importProject()));
      menu.onHide(() => {
        trigger.setAttribute('aria-expanded', 'false');
        if (this.projectMenu === menu) this.projectMenu = undefined;
      });
      trigger.setAttribute('aria-expanded', 'true');
      const bounds = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, trigger.ownerDocument);
    }, primary);
    trigger.addClass('rss-menu-trigger');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
  }

  private async refreshProjects(): Promise<void> {
    const sequence = ++this.loadSequence;
    try {
      const entries = await this.host.listProjects();
      if (!this.opened || sequence !== this.loadSequence) return;
      this.entries = entries;
      if (!entries.some(item => item.project.id === this.selectedId)) this.selectedId = entries[0]?.project.id ?? '';
      options(this.picker, entries.length ? entries.map(item => [item.project.id, item.project.title]) : [['', 'Пока нет проектов']], this.selectedId);
      this.picker.disabled = entries.length === 0;
      this.feedback.hidden = true;
      this.renderProject();
    } catch (error) {
      if (!this.opened || sequence !== this.loadSequence) return;
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    this.feedback.setText(errorMessage(error));
    this.feedback.addClass('rss-error');
    this.feedback.hidden = false;
  }

  private renderProject(force = false): void {
    const entry = this.entry;
    if (!entry) {
      this.renderedId = '';
      this.projectArea.empty();
      const empty = this.projectArea.createDiv({ cls: 'rss-empty rss-welcome' });
      empty.createDiv({ cls: 'rss-empty-symbol', text: '+' });
      empty.createEl('h2', { text: 'Начните с цели поиска' });
      empty.createEl('p', { text: 'Создайте проект для исследования или рабочей задачи. Сохраняйте запросы, выполнения и найденные материалы.' });
      this.projectMenuButton(empty, 'Создать первый проект', true);
      empty.createEl('p', { cls: 'rss-muted rss-small', text: 'Проекты появятся в выбранной папке данных после создания.' });
      return;
    }
    if (force || this.renderedId !== entry.project.id) {
      if (this.renderedId !== entry.project.id) this.focusedStrategyId = '';
      this.renderedId = entry.project.id;
      this.buildProjectLayout();
    }
    if (!entry.project.strategies.some(strategy => strategy.id === this.focusedStrategyId)) this.focusedStrategyId = '';
    this.renderOverview(entry);
    this.renderStats(entry);
    this.updateFilterOptions(entry);
    this.updateTabs();
    this.renderResults();
  }

  private buildProjectLayout(): void {
    this.projectArea.empty();
    this.overview = this.projectArea.createDiv({ cls: 'rss-project-heading' });
    this.statsEl = this.projectArea.createDiv({ cls: 'rss-stats-block' });
    this.contextEl = this.projectArea.createDiv();

    const sectionHead = this.projectArea.createDiv({ cls: 'rss-section-heading' });
    const tabs = sectionHead.createDiv({ cls: 'rss-tabs' });
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Раздел проекта');
    this.strategyTab = button(tabs, 'Запросы', () => this.setTab('strategies'));
    this.journalTab = button(tabs, 'Журнал', () => this.setTab('journal'));
    this.materialsTab = button(tabs, 'Материалы', () => this.setTab('materials'));
    this.strategyTab.setAttribute('role', 'tab');
    this.journalTab.setAttribute('role', 'tab');
    this.materialsTab.setAttribute('role', 'tab');
    this.addButton = button(sectionHead, 'Новый запрос', () => {
      const entry = this.entry;
      if (!entry) return;
      if (this.activeTab === 'strategies') new StrategyModal(this.host, entry, undefined, this.afterSaved).open();
      else if (this.activeTab === 'journal') new RunModal(this.host, entry, undefined, undefined, this.afterSaved).open();
      else new MaterialModal(this.host, entry, undefined, this.afterSaved).open();
    }, true);

    const filters = this.projectArea.createDiv({ cls: 'rss-filters' });
    this.filtersEl = filters;
    const common = filters.createDiv({ cls: 'rss-filter-row rss-filter-primary' });
    this.textInput = labelInput(common, 'Найти');
    this.textInput.type = 'search';
    this.textInput.placeholder = 'Название, текст запроса, комментарий…';
    this.textInput.value = this.filters.text;
    this.textInput.addEventListener('input', () => { this.filters.text = this.textInput.value; this.filtersChanged(); });
    this.platformSelect = labelSelect(common, 'Платформа');
    this.platformSelect.addEventListener('change', () => { this.filters.platform = this.platformSelect.value; this.filtersChanged(); });

    this.strategyFilterRow = filters.createDiv({ cls: 'rss-filter-row' });
    this.strategyStatusSelect = labelSelect(this.strategyFilterRow, 'Статус запроса');
    options(this.strategyStatusSelect, [['', 'Все статусы'], ...Object.entries(STRATEGY_LABELS)], this.filters.strategyStatus);
    this.strategyStatusSelect.addEventListener('change', () => {
      this.filters.strategyStatus = this.strategyStatusSelect.value as Filters['strategyStatus']; this.filtersChanged();
    });

    this.journalFilterRow = filters.createDiv({ cls: 'rss-filter-row rss-journal-filters' });
    this.strategySelect = labelSelect(this.journalFilterRow, 'Запрос');
    this.strategySelect.addEventListener('change', () => { this.filters.strategyId = this.strategySelect.value; this.filtersChanged(); });
    this.purposeSelect = labelSelect(this.journalFilterRow, 'Цель поиска');
    options(this.purposeSelect, [['', 'Все цели'], ...Object.entries(PURPOSE_LABELS)], this.filters.purpose);
    this.purposeSelect.addEventListener('change', () => {
      this.filters.purpose = this.purposeSelect.value as Filters['purpose']; this.filtersChanged();
    });
    this.runStatusSelect = labelSelect(this.journalFilterRow, 'Выполнение');
    options(this.runStatusSelect, [['', 'Все результаты'], ...Object.entries(RUN_STATUS_LABELS)], this.filters.runStatus);
    this.runStatusSelect.addEventListener('change', () => {
      this.filters.runStatus = this.runStatusSelect.value as Filters['runStatus']; this.filtersChanged();
    });
    this.dateFromInput = labelInput(this.journalFilterRow, 'С даты', 'date');
    this.dateFromInput.value = this.filters.dateFrom;
    this.dateFromInput.addEventListener('change', () => { this.filters.dateFrom = this.dateFromInput.value; this.filtersChanged(); });
    this.dateToInput = labelInput(this.journalFilterRow, 'По дату', 'date');
    this.dateToInput.value = this.filters.dateTo;
    this.dateToInput.addEventListener('change', () => { this.filters.dateTo = this.dateToInput.value; this.filtersChanged(); });

    this.materialFilterRow = filters.createDiv({ cls: 'rss-filter-row' });
    this.materialKindSelect = labelSelect(this.materialFilterRow, 'Тип материала');
    options(this.materialKindSelect, [['', 'Все типы'], ...Object.entries(MATERIAL_KINDS)], this.filters.materialKind);
    this.materialKindSelect.addEventListener('change', () => { this.filters.materialKind = this.materialKindSelect.value; this.filtersChanged(); });
    this.materialReadingSelect = labelSelect(this.materialFilterRow, 'Чтение / просмотр');
    options(this.materialReadingSelect, [['', 'Все состояния'], ...Object.entries(READING_STATUSES)], this.filters.readingStatus);
    this.materialReadingSelect.addEventListener('change', () => { this.filters.readingStatus = this.materialReadingSelect.value; this.filtersChanged(); });
    this.materialDecisionSelect = labelSelect(this.materialFilterRow, 'Решение по материалу');
    options(this.materialDecisionSelect, [['', 'Все решения'], ...Object.entries(MATERIAL_DECISIONS)], this.filters.materialDecision);
    this.materialDecisionSelect.addEventListener('change', () => { this.filters.materialDecision = this.materialDecisionSelect.value; this.filtersChanged(); });
    this.materialRunSelect = labelSelect(this.materialFilterRow, 'Найден в выполнении');
    this.materialRunSelect.addEventListener('change', () => { this.filters.materialRunId = this.materialRunSelect.value; this.filtersChanged(); });
    this.filterFeedback = filters.createDiv({ cls: 'rss-form-error' });
    this.filterFeedback.setAttribute('role', 'alert');
    this.filterFeedback.hidden = true;
    const filterFooter = filters.createDiv({ cls: 'rss-filter-footer' });
    this.resultsCount = filterFooter.createDiv({ cls: 'rss-muted rss-small' });
    this.resultsCount.setAttribute('aria-live', 'polite');
    button(filterFooter, 'Сбросить фильтры', () => this.resetFilters());
    this.results = this.projectArea.createDiv({ cls: 'rss-results' });
    this.results.setAttribute('role', 'tabpanel');

    const exportArea = this.projectArea.createDiv({ cls: 'rss-export-bar' });
    const exportCopy = exportArea.createDiv();
    exportCopy.createEl('strong', { text: 'Экспорт проекта' });
    exportCopy.createEl('p', { cls: 'rss-muted rss-small', text: 'JSON переносит весь проект с материалами. CSV журнала и CSV материалов экспортируются отдельно; фильтры не ограничивают экспорт.' });
    const controls = exportArea.createDiv({ cls: 'rss-actions' });
    this.exportSelect = controls.createEl('select');
    this.exportSelect.setAttribute('aria-label', 'Формат экспорта');
    options(this.exportSelect, [['markdown', 'Markdown — отчёт'], ['csv', 'CSV — журнал'], ['materials-csv', 'CSV — материалы'], ['json', 'JSON — полные данные']], 'markdown');
    this.exportButton = button(controls, 'Экспортировать', () => { void this.exportCurrent(); });
  }

  private renderOverview(entry: ProjectEntry): void {
    this.overview.empty();
    const title = this.overview.createDiv();
    title.createEl('h2', { text: entry.project.title });
    const stats = getStats(entry.project);
    title.createEl('p', {
      cls: 'rss-muted rss-small', text: `${stats.strategyCount} запросов · ${stats.runCount} выполнений${stats.latestExecutedAt ? ` · последний поиск ${displaySearchDate(stats.latestExecutedAt)}` : ''}`,
    });
    const actions = this.overview.createDiv({ cls: 'rss-actions' });
    button(actions, 'Открыть заметку', () => { void this.host.openNote(entry.path).catch(error => this.showError(error)); });
    button(actions, 'Настройки проекта', () => new ProjectModal(this.host, entry, this.afterSaved).open());

    const wasOpen = this.contextEl.querySelector('details')?.open ?? false;
    this.contextEl.empty();
    if (entry.project.question || entry.project.criteria || entry.project.deduplicationNotes) {
      const details = this.contextEl.createEl('details', { cls: 'rss-disclosure rss-project-context' });
      details.open = wasOpen;
      details.createEl('summary', { text: 'Вопрос, критерии отбора и учёт повторов' });
      const body = details.createDiv({ cls: 'rss-disclosure-body' });
      for (const [label, value] of [
        ['Цель / вопрос поиска', entry.project.question], ['Критерии отбора', entry.project.criteria],
        ['Учёт повторных записей', entry.project.deduplicationNotes],
      ]) {
        if (!value) continue;
        body.createEl('h4', { text: label });
        body.createEl('p', { cls: 'rss-preserve-lines', text: value });
      }
    }
  }

  private renderStats(entry: ProjectEntry, parent = this.statsEl, heading = 'Сводка по всем выполнениям проекта'): void {
    parent.empty();
    parent.createEl('h3', { cls: 'rss-small-heading', text: heading });
    const stats = getStats(entry.project);
    const grid = parent.createDiv({ cls: 'rss-stats-grid' });
    const fields: Array<[string, KnownTotal]> = [
      ['Показано результатов', stats.totals.reportedHits], ['Просмотрено записей', stats.totals.screenedRecords],
      ['Отобрано после просмотра', stats.totals.selectedRecords], ['Выгружено записей', stats.totals.exportedRecords],
    ];
    for (const [label, total] of fields) {
      const card = grid.createDiv({ cls: 'rss-stat' });
      card.createDiv({ cls: 'rss-stat-label', text: label });
      card.createDiv({ cls: 'rss-stat-number', text: total.known ? countText(total.sum) : '—' });
      card.createDiv({ cls: 'rss-stat-coverage', text: `Указано: ${total.known} из ${total.total} выполнений` });
    }
    parent.createEl('p', {
      cls: 'rss-stat-note',
      text: 'Суммы известных значений по выполнениям. Между поисками возможны повторы; это не число уникальных публикаций.'
        + (entry.project.runs.some(run => run.reportedHitsApproximate && run.reportedHits !== null) ? ' Есть приблизительные значения выдачи.' : ''),
    });
  }

  private updateFilterOptions(entry: ProjectEntry): void {
    const platforms = new Set<string>();
    entry.project.strategies.forEach(strategy => platforms.add(lastRevision(strategy).definition.platform));
    entry.project.runs.forEach(run => platforms.add(run.definition.platform));
    if (this.filters.platform && !platforms.has(this.filters.platform)) this.filters.platform = '';
    options(this.platformSelect, [['', 'Все платформы'], ...[...platforms].sort((a, b) => a.localeCompare(b, 'ru')).map(value => [value, value] as [string, string])], this.filters.platform);
    if (this.filters.strategyId && !entry.project.strategies.some(strategy => strategy.id === this.filters.strategyId)) this.filters.strategyId = '';
    options(this.strategySelect, [['', 'Все запросы'], ...entry.project.strategies.map(strategy => [strategy.id, strategy.title] as [string, string])], this.filters.strategyId);
    if (this.filters.materialRunId && !entry.project.runs.some(run => run.id === this.filters.materialRunId)) this.filters.materialRunId = '';
    options(this.materialRunSelect, [['', 'Все выполнения'], ...entry.project.runs.map(run => [run.id, `${run.executedAt} · ${run.strategyTitle} · v${run.queryRevisionNumber}`] as [string, string])], this.filters.materialRunId);
  }

  private setTab(tab: Tab): void {
    this.focusedStrategyId = '';
    this.activeTab = tab;
    this.updateTabs();
    this.renderResults();
  }

  private updateTabs(): void {
    const detail = Boolean(this.focusedStrategyId);
    this.filtersEl.hidden = detail;
    this.statsEl.hidden = detail;
    this.contextEl.hidden = detail;
    this.addButton.hidden = detail;
    const journal = this.activeTab === 'journal';
    const materials = this.activeTab === 'materials';
    this.strategyTab.toggleClass('is-active', !journal && !materials);
    this.journalTab.toggleClass('is-active', journal);
    this.materialsTab.toggleClass('is-active', materials);
    this.strategyTab.setAttribute('aria-selected', String(!journal && !materials));
    this.journalTab.setAttribute('aria-selected', String(journal));
    this.materialsTab.setAttribute('aria-selected', String(materials));
    this.strategyFilterRow.hidden = journal || materials;
    this.journalFilterRow.hidden = !journal;
    this.materialFilterRow.hidden = !materials;
    this.platformSelect.parentElement!.hidden = materials;
    this.textInput.placeholder = materials ? 'Название, авторы, DOI, заметки…' : 'Название, текст запроса, комментарий…';
    this.addButton.setText(materials ? 'Добавить материал' : journal ? 'Записать выполнение' : 'Новый запрос');
    this.addButton.disabled = journal && !this.entry?.project.strategies.length;
  }

  private filtersChanged(): void {
    this.runLimit = 50;
    this.renderResults();
  }

  private resetFilters(): void {
    this.filters = emptyFilters();
    for (const el of [this.textInput, this.platformSelect, this.strategyStatusSelect, this.strategySelect,
      this.purposeSelect, this.runStatusSelect, this.dateFromInput, this.dateToInput, this.materialKindSelect,
      this.materialReadingSelect, this.materialDecisionSelect, this.materialRunSelect]) el.value = '';
    this.filtersChanged();
  }

  private renderResults(): void {
    const entry = this.entry;
    if (!entry || !this.results) return;
    this.results.empty();
    if (this.focusedStrategyId) {
      const strategy = entry.project.strategies.find(item => item.id === this.focusedStrategyId);
      if (strategy) { this.renderStrategyDetail(entry, strategy); return; }
    }
    this.filterFeedback.hidden = true;
    const needle = this.filters.text.trim().toLocaleLowerCase('ru-RU');
    if (this.activeTab === 'materials') {
      const materials = entry.catalog?.materials ?? [];
      const visible = materials.filter(material => (!this.filters.materialKind || material.kind === this.filters.materialKind)
        && (!this.filters.readingStatus || material.readingStatus === this.filters.readingStatus)
        && (!this.filters.materialDecision || material.decision === this.filters.materialDecision)
        && (!this.filters.materialRunId || material.runIds.includes(this.filters.materialRunId))
        && (!needle || searchText([material.title, material.authors, material.doi, material.url, material.notes, material.exclusionReason, material.year?.toString() ?? '']).includes(needle)));
      this.resultsCount.setText(`Материалов: ${visible.length} из ${materials.length}`);
      this.results.createEl('p', { cls: 'rss-muted rss-small', text: 'Это вручную добавленные карточки. Материал может быть связан с несколькими поисками; счётчики выполнений не пересчитываются.' });
      if (!visible.length) {
        this.emptyResults(materials.length ? 'Материалы не найдены' : 'Добавьте первый материал',
          materials.length ? 'Попробуйте изменить фильтры.' : 'Подойдёт статья, документация, отчёт или веб-страница. Обязательно только название.',
          !materials.length ? () => new MaterialModal(this.host, entry, undefined, this.afterSaved).open() : undefined);
        return;
      }
      const grid = this.results.createDiv({ cls: 'rss-strategy-grid' });
      for (const material of visible.slice(0, this.runLimit)) this.renderMaterial(grid, entry, material);
      if (visible.length > this.runLimit) button(this.results, 'Показать ещё материалы', () => { this.runLimit += 50; this.renderResults(); });
      return;
    }
    if (this.activeTab === 'strategies') {
      const visible = entry.project.strategies.filter(strategy => {
        const definition = lastRevision(strategy).definition;
        return (!this.filters.platform || definition.platform === this.filters.platform)
          && (!this.filters.strategyStatus || strategy.status === this.filters.strategyStatus)
          && (!needle || searchText([strategy.title, definition.database, definition.platform, definition.query,
            definition.filters, definition.searchFields, lastRevision(strategy).changeNote]).includes(needle));
      });
      this.resultsCount.setText(`Запросов: ${visible.length} из ${entry.project.strategies.length}`);
      if (!visible.length) {
        this.emptyResults(entry.project.strategies.length ? 'Запросы не найдены' : 'Сохраните первый запрос',
          entry.project.strategies.length ? 'Попробуйте изменить фильтры.' : 'Укажите базу, платформу и точный текст. Условия поиска будут сохранены вместе с версией.',
          !entry.project.strategies.length ? () => new StrategyModal(this.host, entry, undefined, this.afterSaved).open() : undefined);
        return;
      }
      const grid = this.results.createDiv({ cls: 'rss-strategy-grid' });
      for (const strategy of visible) this.renderStrategy(grid, entry, strategy);
      return;
    }
    if (this.filters.dateFrom && this.filters.dateTo && this.filters.dateFrom > this.filters.dateTo) {
      this.filterFeedback.setText('Начало периода не может быть позже окончания.');
      this.filterFeedback.hidden = false;
      this.resultsCount.setText('Исправьте период поиска.');
      return;
    }
    const visible = entry.project.runs.filter(run => {
      const day = run.executedAt.slice(0, 10);
      return (!this.filters.platform || run.definition.platform === this.filters.platform)
        && (!this.filters.strategyId || run.strategyId === this.filters.strategyId)
        && (!this.filters.purpose || run.purpose === this.filters.purpose)
        && (!this.filters.runStatus || run.status === this.filters.runStatus)
        && (!this.filters.dateFrom || day >= this.filters.dateFrom)
        && (!this.filters.dateTo || day <= this.filters.dateTo)
        && (!needle || searchText([run.strategyTitle, run.definition.database, run.definition.platform,
          run.definition.query, run.definition.filters, run.notes, run.exportPath]).includes(needle));
    }).sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt));
    this.resultsCount.setText(`Выполнений: ${visible.length} из ${entry.project.runs.length}`);
    if (!visible.length) {
      this.emptyResults(entry.project.runs.length ? 'Выполнения не найдены' : 'Журнал пока пуст',
        entry.project.runs.length ? 'Измените фильтры или период.' : 'После поиска внесите дату, использованную версию и известные показатели.',
        !entry.project.runs.length && entry.project.strategies.length
          ? () => new RunModal(this.host, entry, undefined, undefined, this.afterSaved).open() : undefined,
        'Записать выполнение');
      return;
    }
    const journal = this.results.createDiv({ cls: 'rss-journal' });
    for (const run of visible.slice(0, this.runLimit)) this.renderRun(journal, entry, run);
    if (visible.length > this.runLimit) {
      const more = this.results.createDiv({ cls: 'rss-load-more' });
      more.createEl('p', { cls: 'rss-muted', text: `Показано ${this.runLimit} из ${visible.length} выполнений.` });
      button(more, 'Показать ещё 50', () => { this.runLimit += 50; this.renderResults(); });
    }
  }

  private emptyResults(title: string, description: string, action?: () => void, actionLabel = 'Добавить запрос'): void {
    const empty = this.results.createDiv({ cls: 'rss-empty' });
    empty.createEl('h3', { text: title });
    empty.createEl('p', { text: description });
    if (action) button(empty, actionLabel, action, true);
  }

  private renderMaterial(parent: HTMLElement, entry: ProjectEntry, material: Material): void {
    const card = parent.createDiv({ cls: 'rss-strategy-card rss-material-card' });
    card.createEl('h3', { text: material.title });
    card.createEl('p', { cls: 'rss-card-meta', text: [MATERIAL_KINDS[material.kind], material.authors, material.year?.toString() ?? ''].filter(Boolean).join(' · ') });
    card.createEl('p', { cls: 'rss-small', text: `${READING_STATUSES[material.readingStatus]} · ${MATERIAL_DECISIONS[material.decision]}` });
    if (material.decision === 'excluded' && material.exclusionReason) card.createEl('p', { cls: 'rss-preserve-lines', text: `Причина исключения: ${material.exclusionReason}` });
    if (material.doi) card.createEl('p', { cls: 'rss-small', text: `DOI: ${material.doi}` });
    safeLink(card, 'Открыть источник', material.url);
    if (material.notes) card.createEl('p', { cls: 'rss-preserve-lines rss-small', text: material.notes });
    const actions = card.createDiv({ cls: 'rss-actions rss-card-actions' });
    button(actions, 'Изменить материал', () => new MaterialModal(this.host, entry, material, this.afterSaved).open());
    for (const [label, path] of [['Открыть файл', material.filePath], ['Открыть заметку материала', material.notePath]]) {
      if (path) button(actions, label, () => { void this.host.openNote(path).catch(error => this.showError(error)); });
    }
    if (material.strategyIds.length || material.runIds.length || material.history.length) {
      const details = card.createEl('details', { cls: 'rss-disclosure rss-card-detail' });
      details.createEl('summary', { text: 'Источники обнаружения и история материала' });
      const body = details.createDiv({ cls: 'rss-disclosure-body' });
      for (const id of material.strategyIds) {
        const strategy = entry.project.strategies.find(item => item.id === id);
        body.createEl('p', { text: `Запрос: ${strategy?.title ?? id}` });
      }
      for (const id of material.runIds) {
        const run = entry.project.runs.find(item => item.id === id);
        body.createEl('p', { text: run ? `Выполнение: ${displaySearchDate(run.executedAt)} · ${run.strategyTitle} · версия ${run.queryRevisionNumber}` : id });
      }
      for (const change of [...material.history].reverse()) {
        body.createEl('h4', { text: `До изменения ${displayDate(change.changedAt)}` });
        const previous = change.previous;
        body.createEl('p', { text: `${previous.title} · ${MATERIAL_KINDS[previous.kind]} · ${READING_STATUSES[previous.readingStatus]} · ${MATERIAL_DECISIONS[previous.decision]}` });
        for (const [label, value] of [['Авторы / организация', previous.authors], ['Год', previous.year?.toString() ?? ''],
          ['DOI', previous.doi], ['Ссылка', previous.url], ['Файл', previous.filePath], ['Заметка', previous.notePath],
          ['Причина исключения', previous.exclusionReason], ['Заметки о материале', previous.notes]]) {
          if (value) body.createEl('p', { cls: 'rss-preserve-lines', text: `${label}: ${value}` });
        }
      }
    }
  }

  private openStrategy(strategyId: string): void {
    this.focusedStrategyId = strategyId;
    this.detailDecision = '';
    this.detailRunLimit = 50;
    this.updateTabs();
    this.renderResults();
    this.results.querySelector<HTMLElement>('.rss-strategy-detail-title')?.focus();
  }

  private renderStrategyDetail(entry: ProjectEntry, strategy: Strategy): void {
    const detail = this.results.createDiv({ cls: 'rss-strategy-detail' });
    button(detail, '← К списку запросов', () => {
      this.focusedStrategyId = '';
      this.updateTabs();
      this.renderResults();
      Array.from(this.results.querySelectorAll<HTMLElement>('[data-strategy-id]'))
        .find(card => card.dataset.strategyId === strategy.id)?.querySelector<HTMLElement>('.rss-open-strategy')?.focus();
    });
    const title = detail.createEl('h2', { cls: 'rss-strategy-detail-title', text: 'Обзор запроса' });
    title.tabIndex = -1;
    this.renderStrategy(detail, entry, strategy, true);
    const runs = entry.project.runs.filter(run => run.strategyId === strategy.id);
    const runIds = new Set(runs.map(run => run.id));
    const materials = (entry.catalog?.materials ?? []).filter(material => material.strategyIds.includes(strategy.id)
      || material.runIds.some(id => runIds.has(id)));
    const stats = detail.createDiv({ cls: 'rss-stats-block rss-strategy-stats' });
    this.renderStats({ ...entry, project: { ...entry.project, strategies: [strategy], runs } }, stats, 'Статистика запроса');
    stats.createEl('p', { cls: 'rss-muted rss-small', text: `${runs.length} выполнений по всем версиям этого запроса.` });

    const materialSection = detail.createDiv({ cls: 'rss-strategy-materials' });
    materialSection.createEl('h3', { text: 'Материалы запроса' });
    materialSection.createEl('p', { cls: 'rss-material-summary', text: `Связано: ${materials.length} · Отобрано: ${materials.filter(item => item.decision === 'selected').length} · Без решения: ${materials.filter(item => item.decision === 'undecided').length} · Исключено: ${materials.filter(item => item.decision === 'excluded').length}` });
    materialSection.createEl('p', { cls: 'rss-muted rss-small', text: 'Карточки, связанные с запросом напрямую или через его выполнения. Решение по материалу общее для проекта; число карточек учитывается отдельно от статистики выполнений.' });
    const decision = labelSelect(materialSection, 'Показать материалы запроса');
    options(decision, [['', 'Все решения'], ...Object.entries(MATERIAL_DECISIONS)], this.detailDecision);
    decision.addEventListener('change', () => {
      this.detailDecision = decision.value;
      this.renderResults();
      this.results.querySelector<HTMLSelectElement>('[aria-label="Показать материалы запроса"]')?.focus();
    });
    const visible = materials.filter(material => !this.detailDecision || material.decision === this.detailDecision);
    const list = materialSection.createDiv({ cls: 'rss-strategy-material-list' });
    for (const material of visible) this.renderMaterial(list, entry, material);
    if (!visible.length) list.createEl('p', { cls: 'rss-muted', text: materials.length
      ? 'Материалов с этим решением нет.' : 'Связанных материалов пока нет. Добавьте карточку на вкладке «Материалы» и укажите этот запрос или его выполнение.' });

    const journal = detail.createDiv({ cls: 'rss-strategy-journal' });
    journal.createEl('h3', { text: `Выполнения запроса (${runs.length})` });
    if (!runs.length) journal.createEl('p', { cls: 'rss-muted', text: 'Поиск по этому запросу ещё не записан.' });
    for (const run of [...runs].reverse().slice(0, this.detailRunLimit)) this.renderRun(journal, entry, run);
    if (runs.length > this.detailRunLimit) button(journal, 'Показать ещё 50 выполнений', () => {
      this.detailRunLimit += 50;
      this.renderResults();
    });
  }

  private renderStrategy(parent: HTMLElement, entry: ProjectEntry, strategy: Strategy, detail = false): void {
    const revision = lastRevision(strategy);
    const card = parent.createEl('article', { cls: 'rss-strategy-card' });
    card.dataset.strategyId = strategy.id;
    const head = card.createDiv({ cls: 'rss-card-heading' });
    head.createEl('h3', { text: strategy.title });
    head.createEl('span', { cls: `rss-badge rss-status-${strategy.status}`, text: STRATEGY_LABELS[strategy.status] });
    card.createEl('p', { cls: 'rss-card-meta', text: `${revision.definition.database} · ${revision.definition.platform} · версия ${revision.number}` });
    const preview = card.createEl('pre', { cls: 'rss-query-code rss-query-preview', text: revision.definition.query });
    preview.setAttribute('tabindex', '0');
    preview.setAttribute('aria-label', 'Точный текст запроса');
    const runs = entry.project.runs.filter(run => run.strategyId === strategy.id);
    const latestRun = [...runs].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))[0];
    card.createEl('p', { cls: 'rss-muted rss-small', text: runs.length
      ? `${runs.length} выполнений · последнее ${displaySearchDate(latestRun.executedAt)}`
      : 'Выполнения ещё не записаны' });
    const actions = card.createDiv({ cls: 'rss-actions rss-card-actions' });
    if (!detail) button(actions, 'Открыть запрос', () => this.openStrategy(strategy.id), true).addClass('rss-open-strategy');
    button(actions, 'Записать поиск', () => new RunModal(this.host, entry, strategy.id, undefined, this.afterSaved).open(), true);
    button(actions, 'Копировать', () => { void copyQuery(this.app, revision.definition.query); });
    button(actions, 'Изменить', () => new StrategyModal(this.host, entry, strategy, this.afterSaved).open());
    button(actions, `Версии (${strategy.revisions.length})`, () => new RevisionHistoryModal(this.app, strategy).open());
    const details = card.createEl('details', { cls: 'rss-disclosure rss-card-detail' });
    details.createEl('summary', { text: 'Условия и заметки к версии' });
    const body = details.createDiv({ cls: 'rss-disclosure-body' });
    const dl = body.createEl('dl', { cls: 'rss-definition' });
    let conditions = 0;
    for (const [label, value] of [
      ['Поля поиска', revision.definition.searchFields], ['Фильтры', revision.definition.filters],
      ['Годы публикаций', revision.definition.publicationRange], ['Языки', revision.definition.languages],
      ['Комментарий', revision.changeNote],
    ]) {
      if (!value) continue;
      conditions += 1;
      dl.createEl('dt', { text: label }); dl.createEl('dd', { text: value });
    }
    if (!conditions) body.createEl('p', { cls: 'rss-muted', text: 'Дополнительные условия не указаны.' });
    safeLink(body, 'Открыть платформу', revision.definition.searchUrl);
  }

  private renderRun(parent: HTMLElement, entry: ProjectEntry, run: SearchRun): void {
    const card = parent.createEl('article', { cls: 'rss-run-card' });
    const heading = card.createDiv({ cls: 'rss-card-heading' });
    const identity = heading.createDiv();
    identity.createEl('p', { cls: 'rss-run-date', text: displaySearchDate(run.executedAt) });
    identity.createEl('h3', { text: run.strategyTitle });
    const badges = heading.createDiv({ cls: 'rss-badges' });
    badges.createEl('span', { cls: 'rss-badge', text: PURPOSE_LABELS[run.purpose] });
    badges.createEl('span', { cls: `rss-badge rss-status-${run.status}`, text: RUN_STATUS_LABELS[run.status] });
    card.createEl('p', { cls: 'rss-card-meta', text: `${run.definition.database} · ${run.definition.platform} · версия ${run.queryRevisionNumber}` });
    const counters = card.createDiv({ cls: 'rss-run-counts' });
    const values: Array<[string, string]> = [
      ['Показано', `${run.reportedHitsApproximate && run.reportedHits !== null ? '≈ ' : ''}${countText(run.reportedHits)}`],
      ['Просмотрено', countText(run.screenedRecords)], ['Отобрано', countText(run.selectedRecords)],
      ['Выгружено', countText(run.exportedRecords)],
    ];
    for (const [label, value] of values) {
      const item = counters.createDiv();
      item.createEl('span', { cls: 'rss-muted rss-small', text: label });
      item.createEl('strong', { text: value });
    }
    if (run.notes) card.createEl('p', { cls: 'rss-run-note', text: run.notes });
    const foot = card.createDiv({ cls: 'rss-run-footer' });
    const metadata = foot.createDiv({ cls: 'rss-muted rss-small' });
    metadata.setText([
      run.durationMinutes !== null ? `${run.durationMinutes} мин` : '',
      run.history.length ? `Исправлений: ${run.history.length}` : '',
    ].filter(Boolean).join(' · '));
    button(foot, 'Исправить запись', () => new RunModal(this.host, entry, run.strategyId, run, this.afterSaved).open());
    const details = card.createEl('details', { cls: 'rss-disclosure rss-card-detail' });
    details.createEl('summary', { text: 'Запрос, ссылки и история записи' });
    const body = details.createDiv({ cls: 'rss-disclosure-body' });
    body.createEl('p', { cls: 'rss-muted rss-small', text: `Дата поиска: ${run.executedAt}${run.timeZone ? ` · ${run.timeZone}` : ''}. Записано: ${displayDate(run.recordedAt)}.` });
    renderDefinition(body, run.definition);
    const links = body.createDiv({ cls: 'rss-actions rss-run-links' });
    button(links, 'Копировать запрос', () => { void copyQuery(this.app, run.definition.query); });
    safeLink(links, 'Результаты поиска', run.resultUrl);
    safeLink(links, 'Открыть Zotero', run.zoteroLink, true);
    if (run.exportPath) body.createEl('p', { cls: 'rss-file-reference', text: `Файл выгрузки: ${run.exportPath}` });
    if (run.notes) {
      body.createEl('h4', { text: 'Комментарий' });
      body.createEl('p', { cls: 'rss-preserve-lines', text: run.notes });
    }
    if (run.history.length) {
      body.createEl('h4', { text: 'История исправлений' });
      for (const change of [...run.history].reverse()) {
        const item = body.createDiv({ cls: 'rss-correction' });
        item.createEl('strong', { text: displayDate(change.changedAt) });
        item.createEl('p', { text: change.reason });
        item.createEl('p', { cls: 'rss-muted rss-small', text: `До исправления: ${displaySearchDate(change.previous.executedAt)} · ${PURPOSE_LABELS[change.previous.purpose]} · ${RUN_STATUS_LABELS[change.previous.status]}. Показано ${countText(change.previous.reportedHits)}, просмотрено ${countText(change.previous.screenedRecords)}, отобрано ${countText(change.previous.selectedRecords)}, выгружено ${countText(change.previous.exportedRecords)}.` });
      }
    }
  }

  private async exportCurrent(): Promise<void> {
    const entry = this.entry;
    if (!entry || this.exporting) return;
    this.exporting = true;
    this.exportButton.disabled = true;
    this.exportButton.setText('Сохранение…');
    const format = this.exportSelect.value as ExportFormat;
    try {
      const path = await this.host.exportProject(entry, format);
      new Notice(`Экспорт сохранён: ${path}`);
      if (this.opened) {
        this.feedback.empty();
        this.feedback.removeClass('rss-error');
        this.feedback.createEl('span', { text: `Экспорт сохранён: ${path}` });
        if (format === 'markdown') button(this.feedback, 'Открыть отчёт', () => {
          void this.host.openNote(path).catch(error => this.showError(error));
        });
        this.feedback.hidden = false;
      }
    } catch (error) {
      if (this.opened) this.showError(error);
    } finally {
      this.exporting = false;
      if (this.opened) {
        this.exportButton.disabled = false;
        this.exportButton.setText('Экспортировать');
      }
    }
  }
}
