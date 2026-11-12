import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import {
  addRun, addStrategy, editProject, editRun, editStrategy, lastRevision,
  type ProjectInput, type QueryDefinition, type RunInput,
  type SearchRun, type Strategy, type StrategyInput, type StrategyStatus,
} from './model';
import type { ProjectEntry, SearchHost } from './contracts';

export const STRATEGY_LABELS: Record<StrategyStatus, string> = {
  draft: 'Черновик', active: 'В работе', paused: 'Приостановлен', done: 'Завершён',
};
export const PURPOSE_LABELS: Record<RunInput['purpose'], string> = {
  pilot: 'Пробный поиск', main: 'Основной поиск', update: 'Обновление поиска',
};
export const RUN_STATUS_LABELS: Record<RunInput['status'], string> = {
  completed: 'Выполнен', partial: 'Частично', failed: 'Не выполнен',
};

type Saved = (entry: ProjectEntry) => void;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function section(parent: HTMLElement, title: string, description?: string): HTMLElement {
  const el = parent.createDiv({ cls: 'rss-form-section' });
  el.createEl('h3', { text: title });
  if (description) el.createEl('p', { cls: 'rss-muted', text: description });
  return el;
}

function disclosure(parent: HTMLElement, title: string, open = false): HTMLElement {
  const details = parent.createEl('details', { cls: 'rss-disclosure' });
  details.open = open;
  details.createEl('summary', { text: title });
  return details.createDiv({ cls: 'rss-disclosure-body' });
}

function textField(
  parent: HTMLElement, name: string, value: string, change: (value: string) => void,
  description = '', placeholder = '',
): HTMLInputElement {
  let input!: HTMLInputElement;
  const setting = new Setting(parent).setName(name);
  if (description) setting.setDesc(description);
  setting.addText(component => {
    component.setValue(value).setPlaceholder(placeholder).onChange(change);
    input = component.inputEl;
    input.setAttribute('aria-label', name);
  });
  return input;
}

function areaField(
  parent: HTMLElement, name: string, value: string, change: (value: string) => void,
  description = '', rows = 3, placeholder = '',
): HTMLTextAreaElement {
  let input!: HTMLTextAreaElement;
  const setting = new Setting(parent).setName(name);
  setting.settingEl.addClass('rss-setting-stack');
  if (description) setting.setDesc(description);
  setting.addTextArea(component => {
    component.setValue(value).setPlaceholder(placeholder).onChange(change);
    input = component.inputEl;
    input.rows = rows;
    input.setAttribute('aria-label', name);
  });
  return input;
}

function selectField<T extends string>(
  parent: HTMLElement, name: string, value: T, options: Record<T, string>,
  change: (value: T) => void,
): void {
  new Setting(parent).setName(name).addDropdown(component => {
    component.addOptions(options).setValue(value).onChange(next => change(next as T));
    component.selectEl.setAttribute('aria-label', name);
  });
}

export function displayDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}.${month}.${year}`;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(parsed);
}

/** Keep the recorded calendar date visible; journal filters use this same day. */
export function displaySearchDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return value;
  const [, year, month, day, time, offset] = match;
  return `${day}.${month}.${year}${time ? `, ${time} ${offset === 'Z' ? 'UTC' : offset}` : ''}`;
}

export function countText(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU').format(value);
}

/** Uses text-only DOM rendering for exact query strings and other user input. */
export function renderDefinition(parent: HTMLElement, definition: QueryDefinition): void {
  parent.createEl('pre', { cls: 'rss-query-code', text: definition.query });
  const dl = parent.createEl('dl', { cls: 'rss-definition' });
  const fields: Array<[string, string]> = [
    ['База данных', definition.database], ['Платформа', definition.platform],
    ['Поля поиска', definition.searchFields], ['Фильтры', definition.filters],
    ['Годы публикаций', definition.publicationRange], ['Языки', definition.languages],
    ['Адрес поиска', definition.searchUrl],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    dl.createEl('dt', { text: label });
    dl.createEl('dd', { text: value });
  }
}

class ClipboardModal extends Modal {
  constructor(app: App, private readonly value: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('rss-modal');
    this.titleEl.setText('Скопировать запрос');
    this.contentEl.createEl('p', {
      text: 'Буфер обмена недоступен. Выделите текст и скопируйте его обычной командой копирования.',
    });
    const area = this.contentEl.createEl('textarea', { cls: 'rss-copy-area' });
    area.value = this.value;
    area.readOnly = true;
    area.rows = 9;
    area.setAttribute('aria-label', 'Полный текст запроса');
    new Setting(this.contentEl).addButton(button => button.setButtonText('Выделить всё').onClick(() => {
      area.focus(); area.select();
    }));
    area.focus(); area.select();
  }
  onClose(): void { this.contentEl.empty(); }
}

export async function copyQuery(app: App, query: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(query);
    new Notice('Запрос скопирован.');
  } catch {
    new ClipboardModal(app, query).open();
  }
}

abstract class SaveModal extends Modal {
  private saving = false;

  protected prepare(title: string): void {
    this.modalEl.addClass('rss-modal');
    this.titleEl.setText(title);
    this.contentEl.empty();
  }

  protected actions(label: string, save: () => Promise<void>): void {
    const errorEl = this.contentEl.createDiv({ cls: 'rss-form-error' });
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    let saveButton!: ButtonComponent;
    let cancelButton!: ButtonComponent;
    const actions = new Setting(this.contentEl);
    actions.settingEl.addClass('rss-modal-actions');
    actions.addButton(button => {
      cancelButton = button;
      button.setButtonText('Отмена').onClick(() => { if (!this.saving) this.close(); });
    });
    actions.addButton(button => {
      saveButton = button;
      button.setButtonText(label).setCta().onClick(async () => {
        if (this.saving) return;
        this.saving = true;
        errorEl.hidden = true;
        saveButton.setDisabled(true).setButtonText('Сохранение…');
        cancelButton.setDisabled(true);
        try {
          await save();
          this.close();
        } catch (error) {
          errorEl.setText(message(error));
          errorEl.hidden = false;
          errorEl.scrollIntoView({ block: 'nearest' });
        } finally {
          this.saving = false;
          saveButton.setDisabled(false).setButtonText(label);
          cancelButton.setDisabled(false);
        }
      });
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ProjectModal extends SaveModal {
  constructor(private readonly host: SearchHost, private readonly entry?: ProjectEntry, private readonly saved?: Saved) {
    super(host.app);
  }

  onOpen(): void {
    this.prepare(this.entry ? 'Настройки проекта' : 'Новый исследовательский проект');
    const input: ProjectInput = this.entry ? {
      title: this.entry.project.title, question: this.entry.project.question,
      criteria: this.entry.project.criteria, deduplicationNotes: this.entry.project.deduplicationNotes,
    } : { title: '', question: '', criteria: '', deduplicationNotes: '' };
    textField(this.contentEl, 'Название *', input.title, value => { input.title = value; }, '', 'Например, прогнозирование отказов SFP');
    areaField(this.contentEl, 'Исследовательский вопрос', input.question, value => { input.question = value; },
      'Что нужно выяснить по результатам поиска?', 3);
    areaField(this.contentEl, 'Критерии отбора', input.criteria, value => { input.criteria = value; },
      'Условия включения и исключения публикаций.', 4);
    areaField(this.contentEl, 'Учёт повторных записей', input.deduplicationNotes, value => { input.deduplicationNotes = value; },
      'Где и как вы объединяете результаты и удаляете дубликаты.', 3);
    this.actions(this.entry ? 'Сохранить проект' : 'Создать проект', async () => {
      const result = this.entry
        ? await this.host.saveProject(this.entry.path, this.entry.project.revision, editProject(this.entry.project, input), this.entry.fingerprint)
        : await this.host.createProject(input);
      this.saved?.(result);
    });
  }
}

function emptyDefinition(): QueryDefinition {
  return { database: '', platform: '', query: '', searchFields: '', filters: '', publicationRange: '', languages: '', searchUrl: '' };
}

export class StrategyModal extends SaveModal {
  constructor(
    private readonly host: SearchHost, private readonly entry: ProjectEntry,
    private readonly strategy?: Strategy, private readonly saved?: Saved,
  ) { super(host.app); }

  onOpen(): void {
    this.prepare(this.strategy ? 'Редактировать поисковый запрос' : 'Новый поисковый запрос');
    const input: StrategyInput = this.strategy ? {
      title: this.strategy.title, status: this.strategy.status,
      definition: { ...lastRevision(this.strategy).definition }, changeNote: '',
    } : { title: '', status: 'draft', definition: emptyDefinition(), changeNote: '' };
    const def = input.definition;
    textField(this.contentEl, 'Название *', input.title, value => { input.title = value; }, '', 'Краткое название направления поиска');
    selectField(this.contentEl, 'Статус запроса', input.status, STRATEGY_LABELS, value => { input.status = value; });
    textField(this.contentEl, 'База данных *', def.database, value => { def.database = value; },
      'Коллекция, по которой выполняется поиск.', 'Например, Scopus или IEEE Xplore');
    textField(this.contentEl, 'Платформа *', def.platform, value => { def.platform = value; },
      'Интерфейс, через который вы обращаетесь к базе.', 'Например, веб-интерфейс Scopus');
    const queryArea = areaField(this.contentEl, 'Точный текст запроса *', def.query, value => { def.query = value; },
      'Сохраняется с исходными пробелами, кавычками и операторами.', 6,
      '("failure prediction" OR "fault prediction") AND telecommunications');
    queryArea.addClass('rss-query-input');
    queryArea.spellcheck = false;

    const composer = disclosure(this.contentEl, 'Собрать черновик из групп понятий');
    composer.createEl('p', { cls: 'rss-muted', text: 'Внутри группы используется OR, между непустыми группами — AND. По одному синониму в строке; фразы можно заключать в кавычки. Синтаксис нужно проверить на выбранной платформе.' });
    const concepts = ['', '', ''];
    const grid = composer.createDiv({ cls: 'rss-composer-grid' });
    concepts.forEach((_, index) => {
      const cell = grid.createDiv();
      areaField(cell, `Группа ${index + 1}`, '', value => { concepts[index] = value; }, '', 4);
    });
    const preview = composer.createEl('pre', { cls: 'rss-query-code rss-composer-preview', text: 'Заполните хотя бы одну группу.' });
    const draft = () => concepts.map(group => group.split(/\r?\n/).map(term => term.trim()).filter(Boolean))
      .filter(group => group.length).map(group => `(${group.join(' OR ')})`).join(' AND ');
    grid.addEventListener('input', () => { preview.setText(draft() || 'Заполните хотя бы одну группу.'); });
    new Setting(composer).setDesc('Кнопка заменит текст запроса черновиком.').addButton(button =>
      button.setButtonText('Вставить черновик').onClick(() => {
        const value = draft();
        if (!value) { new Notice('Добавьте хотя бы один поисковый термин.'); return; }
        def.query = value;
        queryArea.value = value;
        queryArea.focus();
      }));

    const advanced = disclosure(this.contentEl, 'Поля поиска, фильтры и адрес платформы', Boolean(def.filters || def.searchFields || def.publicationRange || def.languages));
    textField(advanced, 'Поля поиска', def.searchFields, value => { def.searchFields = value; }, '', 'Заголовок, аннотация, ключевые слова…');
    areaField(advanced, 'Фильтры', def.filters, value => { def.filters = value; }, 'Тип документа, предметная область и другие ограничения.', 3);
    textField(advanced, 'Годы публикаций', def.publicationRange, value => { def.publicationRange = value; }, '', 'Например, 2020–2026');
    textField(advanced, 'Языки', def.languages, value => { def.languages = value; }, '', 'Например, русский, английский');
    textField(advanced, 'Адрес поиска', def.searchUrl, value => { def.searchUrl = value; }, 'Полный HTTP(S)-адрес, если нужен.', 'https://…');
    areaField(this.contentEl, this.strategy ? 'Описание изменения версии' : 'Комментарий к первой версии', input.changeNote,
      value => { input.changeNote = value; }, this.strategy
        ? 'При изменении текста, базы, платформы или условий появится новая версия. Сохранённые выполнения сохранят использованную версию.'
        : 'Зачем выбран этот набор терминов и условий?', 2);
    this.actions(this.strategy ? 'Сохранить изменения' : 'Добавить запрос', async () => {
      if (this.strategy && input.changeNote.trim()) {
        const current = lastRevision(this.strategy).definition;
        if ((Object.keys(current) as Array<keyof QueryDefinition>).every(key => current[key] === input.definition[key])) {
          throw new Error('Комментарий к новой версии требует изменения запроса или его условий. Измените их либо очистите комментарий, чтобы сохранить только название и статус.');
        }
      }
      const next = this.strategy ? editStrategy(this.entry.project, this.strategy.id, input) : addStrategy(this.entry.project, input);
      const result = await this.host.saveProject(this.entry.path, this.entry.project.revision, next, this.entry.fingerprint);
      this.saved?.(result);
    });
  }
}

export class RevisionHistoryModal extends Modal {
  constructor(app: App, private readonly strategy: Strategy) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('rss-modal');
    this.titleEl.setText(`Версии: ${this.strategy.title}`);
    this.contentEl.createEl('p', { cls: 'rss-muted', text: 'Каждое выполнение ссылается на конкретную сохранённую версию запроса.' });
    const revisions = [...this.strategy.revisions].reverse();
    for (const [index, revision] of revisions.entries()) {
      const body = disclosure(this.contentEl, `Версия ${revision.number} · ${displayDate(revision.createdAt)}`, index === 0);
      if (revision.changeNote) body.createEl('p', { cls: 'rss-preserve-lines', text: revision.changeNote });
      renderDefinition(body, revision.definition);
      new Setting(body).addButton(button => button.setButtonText('Копировать запрос').onClick(() => copyQuery(this.app, revision.definition.query)));
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function optionalNumber(value: string, label: string, integer: boolean): number | null {
  const cleaned = value.trim();
  if (cleaned === '') return null;
  const pattern = integer ? /^\d+$/ : /^\d+(?:[.,]\d+)?$/;
  if (!pattern.test(cleaned)) throw new Error(`${label}: введите ${integer ? 'целое неотрицательное число' : 'неотрицательное число минут'} или оставьте поле пустым.`);
  const number = Number(cleaned.replace(',', '.'));
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) throw new Error(`${label}: число слишком велико.`);
  return number;
}

function toRunInput(run: SearchRun): RunInput {
  return {
    purpose: run.purpose, status: run.status, executedAt: run.executedAt, timeZone: run.timeZone,
    reportedHits: run.reportedHits, reportedHitsApproximate: run.reportedHitsApproximate,
    screenedRecords: run.screenedRecords, selectedRecords: run.selectedRecords, exportedRecords: run.exportedRecords,
    durationMinutes: run.durationMinutes, resultUrl: run.resultUrl, exportPath: run.exportPath,
    zoteroLink: run.zoteroLink, notes: run.notes,
  };
}

export class RunModal extends SaveModal {
  constructor(
    private readonly host: SearchHost, private readonly entry: ProjectEntry,
    private readonly initialStrategyId?: string, private readonly run?: SearchRun, private readonly saved?: Saved,
  ) { super(host.app); }

  onOpen(): void {
    this.prepare(this.run ? 'Исправить запись о выполнении' : 'Записать выполнение поиска');
    const input: RunInput = this.run ? toRunInput(this.run) : {
      purpose: 'main', status: 'completed', executedAt: localDate(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      reportedHits: null, reportedHitsApproximate: false, screenedRecords: null,
      selectedRecords: null, exportedRecords: null, durationMinutes: null,
      resultUrl: '', exportPath: '', zoteroLink: '', notes: '',
    };
    let strategyId = this.run?.strategyId ?? this.initialStrategyId ?? this.entry.project.strategies[0]?.id ?? '';
    const strategies = this.entry.project.strategies;
    const initialStrategy = strategies.find(item => item.id === strategyId);
    let revisionId = this.run?.queryRevisionId ?? (initialStrategy ? lastRevision(initialStrategy).id : '');
    let correctionReason = '';
    const selected = section(this.contentEl, 'Использованный запрос');
    let revisionSelect: HTMLSelectElement | undefined;
    const selectors = selected.createDiv();
    const snapshot = selected.createDiv({ cls: 'rss-snapshot' });
    const refreshSnapshot = () => {
      snapshot.empty();
      const strategy = strategies.find(item => item.id === strategyId);
      const revision = strategy?.revisions.find(item => item.id === revisionId);
      const definition = this.run?.definition ?? revision?.definition;
      if (!definition) { snapshot.createEl('p', { text: 'Сначала добавьте поисковый запрос.' }); return; }
      const detail = disclosure(snapshot, 'Показать точный запрос и условия', true);
      renderDefinition(detail, definition);
    };
    const refreshRevisions = () => {
      if (!revisionSelect) return;
      revisionSelect.empty();
      const strategy = strategies.find(item => item.id === strategyId);
      if (!strategy) { revisionId = ''; refreshSnapshot(); return; }
      for (const revision of [...strategy.revisions].reverse()) {
        const option = revisionSelect.createEl('option', {
          text: `Версия ${revision.number} · ${displayDate(revision.createdAt)}`, value: revision.id,
        });
        option.selected = revision.id === revisionId;
      }
      revisionSelect.value = revisionId;
      refreshSnapshot();
    };
    if (this.run) {
      selectors.createEl('p', { cls: 'rss-record-title', text: `${this.run.strategyTitle} · версия ${this.run.queryRevisionNumber}` });
    } else {
      new Setting(selectors).setName('Запрос').addDropdown(component => {
        for (const strategy of strategies) component.addOption(strategy.id, strategy.title);
        component.setValue(strategyId).onChange(value => {
          strategyId = value;
          const strategy = strategies.find(item => item.id === strategyId);
          revisionId = strategy ? lastRevision(strategy).id : '';
          refreshRevisions();
        });
        component.selectEl.setAttribute('aria-label', 'Использованный запрос');
      });
      new Setting(selectors).setName('Версия запроса').addDropdown(component => {
        revisionSelect = component.selectEl;
        component.onChange(value => { revisionId = value; refreshSnapshot(); });
        revisionSelect.setAttribute('aria-label', 'Версия использованного запроса');
      });
      refreshRevisions();
    }
    refreshSnapshot();
    selected.createEl('p', { cls: 'rss-muted', text: 'Если фактический запрос или фильтры отличались, сначала сохраните новую версию запроса, затем запишите выполнение с этой версией.' });

    const timing = section(this.contentEl, 'Когда и с какой целью');
    textField(timing, 'Дата поиска *', input.executedAt, value => { input.executedAt = value.trim(); },
      'YYYY-MM-DD или дата и время со смещением: 2026-11-11T17:30:00+03:00.', 'YYYY-MM-DD');
    textField(timing, 'Часовой пояс', input.timeZone, value => { input.timeZone = value.trim(); },
      'IANA-имя; для даты со временем обязательно.', 'Europe/Moscow');
    selectField(timing, 'Цель', input.purpose, PURPOSE_LABELS, value => { input.purpose = value; });
    selectField(timing, 'Результат выполнения', input.status, RUN_STATUS_LABELS, value => { input.status = value; });

    const counts = section(this.contentEl, 'Результаты этого выполнения',
      'Неизвестные значения оставьте пустыми. Ноль означает известное отсутствие записей.');
    const raw = {
      reportedHits: input.reportedHits?.toString() ?? '', screenedRecords: input.screenedRecords?.toString() ?? '',
      selectedRecords: input.selectedRecords?.toString() ?? '', exportedRecords: input.exportedRecords?.toString() ?? '',
      durationMinutes: input.durationMinutes?.toString() ?? '',
    };
    const counterFields: Array<[keyof Pick<RunInput, 'reportedHits' | 'screenedRecords' | 'selectedRecords' | 'exportedRecords'>, string, string]> = [
      ['reportedHits', 'Показано результатов', 'Число, которое показала поисковая система.'],
      ['screenedRecords', 'Просмотрено записей', 'Фактически просмотрено в этом выполнении.'],
      ['selectedRecords', 'Отобрано после просмотра', 'Прошло ваш текущий этап отбора.'],
      ['exportedRecords', 'Выгружено записей', 'Сохранено в выгрузку или перенесено в библиотеку.'],
    ];
    for (const [key, label, description] of counterFields) {
      const el = textField(counts, label, raw[key], value => { raw[key] = value; }, description, 'Не указано');
      el.inputMode = 'numeric';
      el.addClass('rss-count-input');
    }
    new Setting(counts).setName('Показанное число приблизительное')
      .setDesc('Например, платформа показывает «около 1 200».')
      .addToggle(toggle => toggle.setValue(input.reportedHitsApproximate).onChange(value => { input.reportedHitsApproximate = value; }));

    const extras = disclosure(this.contentEl, 'Время, ссылки и файлы', Boolean(input.resultUrl || input.exportPath || input.zoteroLink));
    const minutes = textField(extras, 'Длительность, мин', raw.durationMinutes, value => { raw.durationMinutes = value; }, '', 'Не указано');
    minutes.inputMode = 'decimal';
    textField(extras, 'Адрес результатов', input.resultUrl, value => { input.resultUrl = value; }, '', 'https://…');
    textField(extras, 'Файл выгрузки', input.exportPath, value => { input.exportPath = value; }, 'Путь или имя файла для последующей проверки.', 'exports/results.ris');
    textField(extras, 'Ссылка на Zotero', input.zoteroLink, value => { input.zoteroLink = value; }, 'HTTP(S)-ссылка или zotero://.', 'zotero://…');
    areaField(this.contentEl, 'Комментарий', input.notes, value => { input.notes = value; },
      'Особенности выдачи, причины неполного поиска, решения для следующего шага.', 3);
    if (this.run) {
      areaField(this.contentEl, 'Причина исправления *', '', value => { correctionReason = value; },
        'Предыдущая запись и причина сохранятся в истории.', 2);
      if (this.run.history.length) {
        const history = disclosure(this.contentEl, `Предыдущие исправления (${this.run.history.length})`);
        for (const item of [...this.run.history].reverse()) {
          const record = history.createDiv({ cls: 'rss-correction' });
          record.createEl('h4', { text: displayDate(item.changedAt) });
          record.createEl('p', { text: item.reason });
          record.createEl('p', { cls: 'rss-muted', text: `До исправления: ${displaySearchDate(item.previous.executedAt)}; показано ${countText(item.previous.reportedHits)}, просмотрено ${countText(item.previous.screenedRecords)}, отобрано ${countText(item.previous.selectedRecords)}, выгружено ${countText(item.previous.exportedRecords)}.` });
        }
      }
    }
    this.actions(this.run ? 'Сохранить исправление' : 'Записать выполнение', async () => {
      input.reportedHits = optionalNumber(raw.reportedHits, 'Показано результатов', true);
      input.screenedRecords = optionalNumber(raw.screenedRecords, 'Просмотрено записей', true);
      input.selectedRecords = optionalNumber(raw.selectedRecords, 'Отобрано после просмотра', true);
      input.exportedRecords = optionalNumber(raw.exportedRecords, 'Выгружено записей', true);
      input.durationMinutes = optionalNumber(raw.durationMinutes, 'Длительность', false);
      const next = this.run
        ? editRun(this.entry.project, this.run.id, input, correctionReason)
        : addRun(this.entry.project, strategyId, revisionId, input);
      const result = await this.host.saveProject(this.entry.path, this.entry.project.revision, next, this.entry.fingerprint);
      this.saved?.(result);
    });
  }
}
