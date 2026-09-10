export declare const WORKSPACE_BACKUP_REQUEST: string;
export declare const WORKSPACE_BACKUP_RESULT: string;
export declare const BACKUP_CREDENTIAL_FIELDS: Array<{ section: string; field: string; name: string; env: string }>;
export declare const BACKUP_CREDENTIAL_NAMES: string[];
export declare const DESKTOP_BACKUP_CREDENTIAL_NAMES: string[];
export declare function workspaceBackupCredentials(value: unknown, strict?: boolean): Record<string, string>;
export declare function workspaceBackupEnvironment(credentials: Record<string, string>, brokerUrl: string): Record<string, string>;
export declare function createWorkspaceBackupCredentialBridge(options: {
  isCurrent: (proc: unknown) => boolean;
  available: () => boolean;
  read: () => Record<string, unknown>;
  update: (derive: (current: Record<string, unknown>) => Record<string, unknown>, afterPersist: () => void) => Promise<unknown>;
  brokerUrl: () => string;
  timeoutMs?: number;
}): (proc: { postMessage(message: object): void }, message: unknown) => boolean;
