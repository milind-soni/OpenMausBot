export function cleanWorkspaceDir(dataDir: string): string;
/** The folder beside the data folder that holds one folder per profile, each named by its id. */
export function profilesDir(dataDir: string): string;
export function profileDir(dataDir: string, id: string): string;
export declare const DEFAULT_PROFILE: "default";
export function cleanWorkspaceConfig(language?: string | null, now?: Date): { language?: string; onboarding: { completedAt: string; version: number; hintsSeen: string[] } };
export interface CleanWorkspace {
  active(): boolean;
  stranded(): boolean;
  profile(): string | null;
  ownCopy(): boolean;
  marker(): { frozen: boolean; cloud?: string; place?: string };
  enter(): Promise<boolean>;
  open(id?: string): Promise<boolean>;
  leave(): Promise<boolean>;
  holding<T>(work: () => Promise<T>): Promise<T>;
  realCopy(request: (route: string, init?: RequestInit) => Promise<Response>): (route: string, init?: RequestInit) => Promise<Response>;
}
export function createCleanWorkspace(deps: {
  dataDir(): string;
  running(): string | null;
  swap(dir: string): Promise<{ ok: boolean }>;
  allowed?(): boolean;
  t?(key: string, params?: Record<string, string | number>): string;
  changed?(): void;
  log?(line: string): void;
}): CleanWorkspace;
