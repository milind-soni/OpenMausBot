/** Full, encrypted workspace snapshots are distinct from additive team copies. */
export interface WorkspaceBackupSummary {
  format: "openmaus.workspace-backup";
  version: 1;
  id: string;
  createdAt: string;
  appVersion: string;
  files: number;
  directories: number;
  bytes: number;
  bots: number;
  groups: number;
  threads: number;
  messages: number;
  includesCredentials: boolean;
  exclusions: string[];
  warnings: string[];
}

export type WorkspaceBackupClientState = Record<string, string>;

export interface WorkspaceBackupPrivateMetadata {
  summary: WorkspaceBackupSummary;
  credentials: Record<string, unknown>;
  clientState: WorkspaceBackupClientState;
}
