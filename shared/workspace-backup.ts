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

export type WorkspaceBackupClientState = Record<string, string>;

export interface WorkspaceBackupSelection {
  conversations: boolean;
  attachments: boolean;
  workspaceFiles: boolean;
  /** Inclusive UTC calendar dates. Keep whole conversations active in this range. */
  from?: string;
  to?: string;
}

export const COMPLETE_WORKSPACE_BACKUP: WorkspaceBackupSelection = {
  conversations: true, attachments: true, workspaceFiles: true,
};

export interface WorkspaceBackupEstimate {
  bytes: number;
  files: number;
  categories: Record<"settings" | "conversations" | "attachments" | "workspaceFiles", number>;
}

export interface WorkspaceBackupPrivateMetadata {
  summary: WorkspaceBackupSummary;
  clientState: WorkspaceBackupClientState;
}
