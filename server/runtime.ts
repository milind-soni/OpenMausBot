// The server's composition root, extracted verbatim from index.ts: the
// process-wide singletons (config, provider registry, Store) together with
// the boot side effects their construction depends on (directory layout,
// data-directory lease, workspace restore, environment identity, engine
// registration, registry load, Store seeding). index.ts imports these
// bindings from here, so evaluating this module performs the same
// initialization, in the same relative order, that index.ts ran inline
// before its own remaining body. Nothing here may import index.ts — keep
// this module importable by tsc's cycle check and by every future
// extraction that needs the singletons.
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DATA_DIR,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  threadEventLogMaxBytes,
} from "./config.ts";
import { acquireDataDirLeaseForProcess } from "./data-dir-lease.ts";
import { registerEnginesBinDir } from "./engine-install.ts";
import { loadEnvironmentId } from "./environment.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { bindThreadLogCapProvider } from "./thread-log-rotation.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";
import { Store } from "./store.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { applyPendingWorkspaceRestore, readLastWorkspaceRestore, type WorkspaceRestoreResult } from "./workspace-backup.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

ensureDirs();
// The desktop parent owns the primary lease and delegates one private child
// claim; a standalone/headless server owns the primary lease itself. Acquire
// before any durable identity, sessions, config, or Store state is loaded.
const dataDirLease = acquireDataDirLeaseForProcess(DATA_DIR);
let dataDirLeaseReleaseAttempted = false;
export function releaseDataDirLeaseAtExit(): void {
  if (dataDirLeaseReleaseAttempted) return;
  dataDirLeaseReleaseAttempted = true;
  try {
    dataDirLease.release();
  } catch (error) {
    // A failed release deliberately leaves a stale, owner-token-protected
    // lease. The next process can recover it only after this PID is dead.
    console.error(`[data-directory] lease release failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.once("exit", releaseDataDirLeaseAtExit);
// Restore before constructing any long-lived config, Store, session or provider
// objects. Replacing files underneath a live Store would overwrite restored data.
export let workspaceRestore: WorkspaceRestoreResult = { restored: false };
if (existsSync(join(DATA_DIR, ".backups"))) {
  workspaceRestore = applyPendingWorkspaceRestore(DATA_DIR);
  if (!workspaceRestore.restored && !workspaceRestore.rolledBack) {
    workspaceRestore = readLastWorkspaceRestore(DATA_DIR) ?? workspaceRestore;
  }
}
export const workspaceMaintenance = new WorkspaceBackupMaintenance();
// Only after ensureDirs(): it performs the one-time rename of the legacy data
// dir, which must not find a freshly created ~/.openmausbot already there.
// Remote clients (server/request-auth.ts, server/sessions.ts): a stable identity
// for this server, the paired sessions, and the cookie the served UI uses.
export const ENVIRONMENT_ID = loadEnvironmentId(DATA_DIR);
export const cfg = loadConfig();
// The per-thread event log cap is checked after every NDJSON append.
// config.json is read once per process (a change restarts the server, like
// every other hand-edited knob), so a binding made here never goes stale.
bindThreadLogCapProvider(() => threadEventLogMaxBytes(cfg));
export const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
// Engines installed from Settings live under the data directory and win over
// any other copy on PATH.
registerEnginesBinDir();
await registry.load(instanceConfigs(cfg));
export const teamComputerTurns = new Map<string, { owner: TurnOwner; computerId: string; botId: string; remoteAgent: boolean }>();

// New bots honor setup's saved choice; unconfigured workspaces prefer Claude.
export async function defaultSelection() {
  return selectDefaultModelSelection(await registry.describe(), cfg.defaultModelSelection);
}

let bootSelection = { instanceId: "", model: "" };
export const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();
