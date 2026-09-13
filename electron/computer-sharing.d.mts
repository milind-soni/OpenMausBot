export interface SharedFolder { id: string; name: string; path: string; write: boolean }
export interface SharingState {
  enabled: boolean;
  folders: SharedFolder[];
  terminal: boolean;
  computer: boolean;
  connected?: boolean;
  error?: string;
}
interface Workspace { id: string; name: string; origin: string }
interface Identity { sessionId: string; environmentId: string }
export function validateSharedFolders(folders: unknown): Promise<SharedFolder[]>;
export function createComputerSharing(options: {
  file: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  environments: () => Workspace[];
  cuaConnection: () => Promise<{ mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | null>;
  hostControl?: (id: string, signal: AbortSignal) => Promise<{ renew(): Promise<unknown>; release(): Promise<unknown> }>;
}): {
  state(id: string): SharingState;
  identity(env: Workspace): Promise<Identity>;
  observe(env: Workspace): Promise<Identity | null>;
  decline(env: Workspace, identity: Identity): void;
  save(env: Workspace, input: Pick<SharingState, "folders" | "terminal" | "computer">, identity: Identity): Promise<SharingState>;
  revoke(env: Workspace): SharingState;
  forget(env: Workspace): void;
  start(): void;
  close(): void;
};
