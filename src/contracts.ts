import type { App } from 'obsidian';
import type { Project, ProjectInput } from './model';

export const VIEW_TYPE = 'research-search-view';

export interface ProjectEntry {
  path: string;
  project: Project;
  fingerprint: string;
}

export type ExportFormat = 'markdown' | 'csv' | 'json';

export interface SearchHost {
  app: App;
  listProjects(): Promise<ProjectEntry[]>;
  createProject(input: ProjectInput): Promise<ProjectEntry>;
  saveProject(path: string, expectedRevision: number, next: Project, expectedFingerprint: string): Promise<ProjectEntry>;
  exportProject(entry: ProjectEntry, format: ExportFormat): Promise<string>;
  openNote(path: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  getDataFolder(): string;
}
