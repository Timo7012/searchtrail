/** Minimal in-memory Vault used only by repository tests; not shipped in the plugin bundle. */
export class TFile {
  constructor(public path: string) {}
  get name(): string { return this.path.split('/').pop() || this.path; }
  get extension(): string { return this.name.includes('.') ? this.name.split('.').pop()! : ''; }
  get basename(): string { return this.name.replace(/\.[^.]+$/, ''); }
}

export class TFolder { constructor(public path: string) {} }

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export class MemoryVault {
  configDir = '.obsidian';
  readonly entries = new Map<string, TFile | TFolder>();
  readonly contents = new Map<string, string>();
  readonly createdPaths: string[] = [];
  beforeRead: ((file: TFile) => void | Promise<void>) | null = null;

  getAbstractFileByPath(path: string): TFile | TFolder | null { return this.entries.get(path) ?? null; }
  getMarkdownFiles(): TFile[] {
    return [...this.entries.values()].filter((entry): entry is TFile => entry instanceof TFile && entry.extension === 'md');
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.entries.has(path)) throw new Error(`Already exists: ${path}`);
    this.requireParent(path);
    const folder = new TFolder(path);
    this.entries.set(path, folder);
    return folder;
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.entries.has(path)) throw new Error(`Already exists: ${path}`);
    this.requireParent(path);
    const file = new TFile(path);
    this.entries.set(path, file);
    this.contents.set(path, content);
    this.createdPaths.push(path);
    return file;
  }

  async read(file: TFile): Promise<string> {
    if (this.beforeRead) await this.beforeRead(file);
    const content = this.contents.get(file.path);
    if (content === undefined) throw new Error(`Missing file: ${file.path}`);
    return content;
  }

  async process(file: TFile, processor: (content: string) => string): Promise<string> {
    const content = this.contents.get(file.path);
    if (content === undefined) throw new Error(`Missing file: ${file.path}`);
    const next = processor(content);
    this.contents.set(file.path, next);
    return next;
  }

  /** Simulates editing a file outside the plugin, without a plugin revision bump. */
  externalWrite(path: string, content: string): void {
    if (!(this.entries.get(path) instanceof TFile)) throw new Error(`Missing file: ${path}`);
    this.contents.set(path, content);
  }

  private requireParent(path: string): void {
    const slash = path.lastIndexOf('/');
    if (slash >= 0 && !(this.entries.get(path.slice(0, slash)) instanceof TFolder)) throw new Error(`Missing parent: ${path}`);
  }
}

export class App { constructor(public vault = new MemoryVault()) {} }
