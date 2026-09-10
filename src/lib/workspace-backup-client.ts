import { WORKSPACE_BACKUP_CLIENT_KEYS, type WorkspaceBackupClientState } from "../../shared/workspace-backup-client";

export const WORKSPACE_RESTORE_MARKER = "omb-pending-workspace-restore";

export function collectWorkspaceClientState(storage: Pick<Storage, "getItem"> = localStorage): WorkspaceBackupClientState {
  const result: WorkspaceBackupClientState = {};
  for (const key of WORKSPACE_BACKUP_CLIENT_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

/** Replace only allowlisted keys; authentication and unrelated app state survive. */
export function applyWorkspaceClientState(value: unknown, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backup browser state");
  const values = value as Record<string, unknown>;
  const allowed = new Set<string>(WORKSPACE_BACKUP_CLIENT_KEYS);
  if (Object.entries(values).some(([key, entry]) => !allowed.has(key) || typeof entry !== "string")) throw new Error("Invalid backup browser state");
  const original = collectWorkspaceClientState(storage);
  try {
    for (const key of WORKSPACE_BACKUP_CLIENT_KEYS) storage.removeItem(key);
    for (const key of WORKSPACE_BACKUP_CLIENT_KEYS) {
      if (Object.hasOwn(values, key)) storage.setItem(key, values[key] as string);
    }
  } catch (error) {
    // A full browser quota must not silently leave half-restored drafts.
    for (const key of WORKSPACE_BACKUP_CLIENT_KEYS) storage.removeItem(key);
    for (const key of WORKSPACE_BACKUP_CLIENT_KEYS) {
      if (original[key] !== undefined) storage.setItem(key, original[key]);
    }
    throw error;
  }
}
