export function cleanWorkspaceDir(dataDir: string): string;
export function cleanWorkspaceConfig(language?: string | null, now?: Date): { language?: string; onboarding: { completedAt: string; version: number; hintsSeen: string[] } };
export interface CleanWorkspace {
  active(): boolean;
  ownCopy(): boolean;
  marker(): { frozen: boolean; cloud?: string; place?: string };
  enter(): Promise<boolean>;
  leave(): Promise<boolean>;
  holding<T>(work: () => Promise<T>): Promise<T>;
  realCopy(request: (route: string, init?: RequestInit) => Promise<Response>): (route: string, init?: RequestInit) => Promise<Response>;
}
export function createCleanWorkspace(deps: {
  dataDir(): string;
  running(): string | null;
  swap(dir: string): Promise<{ ok: boolean }>;
  allowed?(): boolean;
  changed?(): void;
  log?(line: string): void;
}): CleanWorkspace;
