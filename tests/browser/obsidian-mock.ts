/**
 * Browser smoke-test adapter only. This is not an Obsidian implementation.
 * It supplies just the public DOM/UI surface exercised by our view and modals.
 * The production bundle never includes this module.
 */

type ElementInfo = {
  text?: string | DocumentFragment;
  cls?: string | string[];
  attr?: Record<string, string>;
  type?: string;
  href?: string;
  value?: string;
};

function createElement<K extends keyof HTMLElementTagNameMap>(
  parent: Node, tag: K, info: ElementInfo = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
  if (typeof info.text === 'string') element.textContent = info.text;
  else if (info.text) element.appendChild(info.text);
  for (const [key, value] of Object.entries(info.attr ?? {})) element.setAttribute(key, value);
  if (info.type) element.setAttribute('type', info.type);
  if (info.href) element.setAttribute('href', info.href);
  if (info.value !== undefined) (element as HTMLInputElement).value = info.value;
  parent.appendChild(element);
  return element;
}

function extend(prototype: object, name: string, fn: (...args: any[]) => any): void {
  Object.defineProperty(prototype, name, { value: fn, configurable: true, writable: true });
}

extend(HTMLElement.prototype, 'createEl', function (this: HTMLElement, tag: keyof HTMLElementTagNameMap, info?: ElementInfo) {
  return createElement(this, tag, info);
});
extend(HTMLElement.prototype, 'createDiv', function (this: HTMLElement, info?: ElementInfo) { return createElement(this, 'div', info); });
extend(HTMLElement.prototype, 'empty', function (this: HTMLElement) { this.replaceChildren(); });
extend(HTMLElement.prototype, 'setText', function (this: HTMLElement, text: string | DocumentFragment) {
  if (typeof text === 'string') this.textContent = text;
  else this.replaceChildren(text);
});
extend(HTMLElement.prototype, 'addClass', function (this: HTMLElement, ...names: string[]) { this.classList.add(...names); });
extend(HTMLElement.prototype, 'removeClass', function (this: HTMLElement, ...names: string[]) { this.classList.remove(...names); });
extend(HTMLElement.prototype, 'toggleClass', function (this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); });

export class App {}
export interface WorkspaceLeaf { app: App }

export class ItemView {
  app: App;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl = createElement(document.querySelector('#app')!, 'div', { cls: 'workspace-leaf' });
    this.contentEl = createElement(this.containerEl, 'div', { cls: 'view-content' });
  }
}

export class Notice {
  constructor(message: string, _duration?: number) {
    const container = document.querySelector('#notices')!;
    createElement(container, 'div', { cls: 'notice', text: message, attr: { role: 'status' } });
  }
}

export class Modal {
  containerEl: HTMLDivElement;
  modalEl: HTMLDivElement;
  titleEl: HTMLHeadingElement;
  contentEl: HTMLDivElement;
  private closed = false;
  constructor(public app: App) {
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'modal-container';
    this.modalEl = createElement(this.containerEl, 'div', { cls: 'modal', attr: { role: 'dialog', 'aria-modal': 'true' } });
    this.titleEl = createElement(this.modalEl, 'h2', { cls: 'modal-title' });
    this.contentEl = createElement(this.modalEl, 'div', { cls: 'modal-content' });
  }
  onOpen(): void | Promise<void> {}
  onClose(): void {}
  private escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };
  open(): void {
    this.closed = false;
    document.body.appendChild(this.containerEl);
    document.addEventListener('keydown', this.escape);
    void this.onOpen();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    document.removeEventListener('keydown', this.escape);
    this.containerEl.remove();
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(container: HTMLElement) {
    this.buttonEl = createElement(container, 'button', { type: 'button' });
  }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  setCta(): this { this.buttonEl.classList.add('mod-cta'); return this; }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', event => { void callback(event); }); return this;
  }
}

class TextComponent {
  inputEl: HTMLInputElement;
  constructor(container: HTMLElement) { this.inputEl = createElement(container, 'input', { type: 'text' }); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => { void callback(this.inputEl.value); }); return this;
  }
}

class TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  constructor(container: HTMLElement) { this.inputEl = createElement(container, 'textarea'); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => { void callback(this.inputEl.value); }); return this;
  }
}

class DropdownComponent {
  selectEl: HTMLSelectElement;
  constructor(container: HTMLElement) { this.selectEl = createElement(container, 'select'); }
  addOption(value: string, label: string): this { createElement(this.selectEl, 'option', { value, text: label }); return this; }
  addOptions(options: Record<string, string>): this {
    Object.entries(options).forEach(([value, label]) => this.addOption(value, label)); return this;
  }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.selectEl.addEventListener('change', () => { void callback(this.selectEl.value); }); return this;
  }
}

class ToggleComponent {
  private input: HTMLInputElement;
  constructor(container: HTMLElement) { this.input = createElement(container, 'input', { type: 'checkbox' }); }
  setValue(value: boolean): this { this.input.checked = value; return this; }
  onChange(callback: (value: boolean) => unknown): this {
    this.input.addEventListener('change', () => { void callback(this.input.checked); }); return this;
  }
}

export class Setting {
  settingEl: HTMLDivElement;
  infoEl: HTMLDivElement;
  nameEl: HTMLDivElement;
  descEl: HTMLDivElement;
  controlEl: HTMLDivElement;
  constructor(parent: HTMLElement) {
    this.settingEl = createElement(parent, 'div', { cls: 'setting-item' });
    this.infoEl = createElement(this.settingEl, 'div', { cls: 'setting-item-info' });
    this.nameEl = createElement(this.infoEl, 'div', { cls: 'setting-item-name' });
    this.descEl = createElement(this.infoEl, 'div', { cls: 'setting-item-description' });
    this.controlEl = createElement(this.settingEl, 'div', { cls: 'setting-item-control' });
  }
  setName(value: string): this { this.nameEl.textContent = value; return this; }
  setDesc(value: string): this { this.descEl.textContent = value; return this; }
  addText(callback: (component: TextComponent) => unknown): this { callback(new TextComponent(this.controlEl)); return this; }
  addTextArea(callback: (component: TextAreaComponent) => unknown): this { callback(new TextAreaComponent(this.controlEl)); return this; }
  addDropdown(callback: (component: DropdownComponent) => unknown): this { callback(new DropdownComponent(this.controlEl)); return this; }
  addToggle(callback: (component: ToggleComponent) => unknown): this { callback(new ToggleComponent(this.controlEl)); return this; }
  addButton(callback: (component: ButtonComponent) => unknown): this { callback(new ButtonComponent(this.controlEl)); return this; }
}
