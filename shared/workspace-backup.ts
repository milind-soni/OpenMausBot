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
  exclusions: string[];
  warnings: string[];
}

/** What a restore from another kind of computer (Windows to Linux, say) could not bring: folders and files outside
 * that computer's data folder. */
export interface WorkspaceLeftBehind {
  /** Bots whose working folder stayed there; they now start in their own folder. */
  bots: number;
  /** Up to 20 of those folders and of the files their instructions name, as written there. */
  paths: string[];
}

export type WorkspaceBackupClientState = Record<string, string>;

export interface WorkspaceBackupPrivateMetadata {
  summary: WorkspaceBackupSummary;
  clientState: WorkspaceBackupClientState;
}
