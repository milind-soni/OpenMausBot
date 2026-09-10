// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "omb-drafts",
  "omb-draft-attachments",
  "omb-draft-send-ids",
  "omb-draft-channel-modes",
  "omb-skin",
  "omb-show-threads",
  "openmausbot.sidebarDensity",
  "openmausbot.sidebarCollapsedSections.v1",
  "openmausbot.sidebarSectionOrder.v1",
  "omb-analytics-opt-out",
  "openmausbot.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
