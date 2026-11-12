/** UI integration harness: real view/model, in-memory SearchHost, mocked Obsidian UI. */
import type { App, WorkspaceLeaf } from 'obsidian';
import { ResearchSearchView } from '../../src/view';
import { createProject as createDomainProject, parseProject, type Project, type ProjectInput } from '../../src/model';
import type { ExportFormat, ProjectEntry, SearchHost } from '../../src/contracts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const listeners = new Set<() => void>();
const projects: ProjectEntry[] = [];
const exports: Array<{ projectId: string; format: ExportFormat }> = [];
const openedNotes: string[] = [];
let nextSaveError = '';
let saveCalls = 0;

function makeEntry(project: Project): ProjectEntry {
  return { path: `SearchTrail/${project.id}.md`, project, fingerprint: JSON.stringify(project) };
}

function emit(): void { listeners.forEach(callback => callback()); }

const app = {} as App;
const host: SearchHost = {
  app,
  async listProjects() { return clone(projects); },
  async createProject(input: ProjectInput) {
    const entry = makeEntry(createDomainProject(input));
    projects.push(entry);
    emit();
    return clone(entry);
  },
  async saveProject(path: string, expectedRevision: number, next: Project, expectedFingerprint: string) {
    saveCalls += 1;
    if (nextSaveError) {
      const message = nextSaveError;
      nextSaveError = '';
      throw new Error(message);
    }
    const index = projects.findIndex(entry => entry.path === path);
    if (index === -1) throw new Error('Project missing');
    const current = projects[index];
    if (current.project.revision !== expectedRevision || current.fingerprint !== expectedFingerprint) throw new Error('Concurrent project change');
    projects[index] = makeEntry(parseProject(next));
    emit();
    return clone(projects[index]);
  },
  async exportProject(entry, format) {
    exports.push({ projectId: entry.project.id, format });
    return `Exports/search.${format === 'markdown' ? 'md' : format}`;
  },
  async openNote(path) { openedNotes.push(path); },
  subscribe(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
  getDataFolder() { return 'SearchTrail'; },
};

const leaf = { app } as unknown as WorkspaceLeaf;
const view = new ResearchSearchView(leaf, host);
type LifecycleView = { onOpen(): Promise<void>; onClose(): Promise<void> };

declare global {
  interface Window {
    rssHarness: {
      snapshot(): { projects: ProjectEntry[]; exports: typeof exports; openedNotes: string[]; saveCalls: number; subscribers: number };
      failNextSave(message: string): void;
      unmount(): Promise<void>;
    };
  }
}

window.rssHarness = {
  snapshot: () => clone({ projects, exports, openedNotes, saveCalls, subscribers: listeners.size }),
  failNextSave: message => { nextSaveError = message; },
  unmount: async () => { await (view as unknown as LifecycleView).onClose(); },
};

void (view as unknown as LifecycleView).onOpen().then(() => {
  document.body.dataset.ready = 'true';
});
