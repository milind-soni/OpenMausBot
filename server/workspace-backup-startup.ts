import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import {
  applyPendingWorkspaceRestore, readPendingWorkspaceRestoreMetadata, readLastWorkspaceRestore,
  isWorkspaceRestoreCommitted,
  type WorkspaceRestoreResult,
} from "./workspace-backup.ts";
import {
  loadWorkspaceBackupCredentials, persistWorkspaceBackupCredentials,
  readDesktopBackupCredentials, restoreDesktopBackupCredentials,
} from "./workspace-backup-desktop.ts";

/** The OS credential store is outside DATA_DIR. Retain its pre-restore state
 * before changing it, so a crash between the two stores can be recovered on
 * the next launch as well as a normal thrown error. No renderer sees it. */
export async function restoreWorkspaceBackupOnStartup(dataDir: string): Promise<WorkspaceRestoreResult> {
  // Ordinary launches must not impose the backup feature's stricter path
  // rules on an existing workspace (for example a user-managed symlink).
  if (!existsSync(join(dataDir, ".backups"))) {
    await loadWorkspaceBackupCredentials(dataDir);
    return { restored: false };
  }
  const rollbackFile = join(dataDir, ".backups", "credential-rollback.json");
  let previous: { id: string; credentials: Record<string, unknown> } | undefined;
  if (existsSync(rollbackFile)) {
    const stat = lstatSync(rollbackFile);
    if (!stat.isFile() || stat.size > 132_096) throw new Error("Invalid backup credential recovery file. Original data is preserved.");
    const value: unknown = JSON.parse(readFileSync(rollbackFile, "utf8"));
    if (!value || typeof value !== "object" || !("id" in value) || !("credentials" in value) ||
      typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) ||
      !value.credentials || typeof value.credentials !== "object" || Array.isArray(value.credentials)) {
      throw new Error("Invalid backup credential recovery state. Original data is preserved.");
    }
    previous = { id: value.id, credentials: value.credentials as Record<string, unknown> };
  }

  const pending = readPendingWorkspaceRestoreMetadata(dataDir);
  if (pending) {
    if (previous && previous.id !== pending.id) throw new Error("An earlier workspace restore needs recovery before another can start.");
    if (!previous) {
      previous = { id: pending.id, credentials: await readDesktopBackupCredentials() ?? {} };
      writeFileAtomic(rollbackFile, JSON.stringify(previous), { mode: 0o600 });
    }
    try {
      await restoreDesktopBackupCredentials(pending.credentials);
      const result = applyPendingWorkspaceRestore(dataDir, {
        beforeCommit: () => persistWorkspaceBackupCredentials(dataDir, pending.credentials),
      });
      if (result.rolledBack) await restoreDesktopBackupCredentials(previous.credentials);
      // Keep the old secure-store values next to the automatic safety copy.
      if (result.restored && result.safetyCopyPath) writeFileAtomic(join(result.safetyCopyPath, "credentials.json"), JSON.stringify(previous.credentials), { mode: 0o600 });
      unlinkSync(rollbackFile);
      await loadWorkspaceBackupCredentials(dataDir);
      return result;
    } catch (error) {
      // If the disk commit completed, a later bookkeeping failure must not
      // roll back only credentials and leave them mismatched with new data.
      if (!isWorkspaceRestoreCommitted(dataDir, pending.id)) await restoreDesktopBackupCredentials(previous.credentials);
      throw error;
    }
  }

  const recovered = applyPendingWorkspaceRestore(dataDir);
  const last = readLastWorkspaceRestore(dataDir);
  if (previous) {
    if (recovered.rolledBack || last?.id !== previous.id) await restoreDesktopBackupCredentials(previous.credentials);
    else if (last.safetyCopyPath) writeFileAtomic(join(last.safetyCopyPath, "credentials.json"), JSON.stringify(previous.credentials), { mode: 0o600 });
    unlinkSync(rollbackFile);
  }
  await loadWorkspaceBackupCredentials(dataDir);
  return recovered.restored || recovered.rolledBack ? recovered : last ?? { restored: false };
}
