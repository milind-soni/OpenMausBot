// The attachments', the thread logs' and the task workspaces' upkeep. All are safe beside requests: an upload in
// flight keeps its partial and its reservation, and a busy, unread or handed-off thread keeps its log and its
// workspace. So the first pass runs once the server answers, not before it listens, and the sweeps then run once a day.
// The task workspaces' sweep is held off unless OMB_TASK_WORKSPACE_RETENTION is on: it deletes any node_modules and
// any venv outright, without checking that a package manager made them, so a venv holding the person's own script or
// a hand-written node_modules would go, and on a desktop a task workspace can be a project the person also works in.
// The cache cap's sweeper (cache-sweep/) starts here too; it deletes nothing while a turn or an engine process is alive.
import { cleanupStaleAttachmentPartials } from "../attachments.ts";
import type { BotRecord } from "../store.ts";
import { sweepTaskWorkspaceBuildFolders } from "../task-workspace-retention.ts";
import { sweepThreadEventLogs } from "../thread-retention.ts";

export const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
export const TASK_WORKSPACE_RETENTION_ENV = "OMB_TASK_WORKSPACE_RETENTION";

/** The task workspaces' sweep runs only when OMB_TASK_WORKSPACE_RETENTION is 1, on, true or yes. */
export function taskWorkspaceRetentionOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "on", "true", "yes"].includes(env[TASK_WORKSPACE_RETENTION_ENV]?.trim().toLowerCase() ?? "");
}

export interface StartUpkeepDeps {
  bots: () => ReadonlyArray<Pick<BotRecord, "id" | "tasks">>;
  retentionDays: () => number | null;
  busy: (botId: string, threadId: string) => boolean;
  openDirectHandoff: (threadId: string) => boolean;
  cleanupPartials?: () => number;
  caches?: { start(busy: () => boolean): void };
  enginesLive?: () => boolean;
  sweepLogs?: typeof sweepThreadEventLogs;
  sweepWorkspaces?: (candidates: Parameters<typeof sweepTaskWorkspaceBuildFolders>[0]) => string[] | Promise<string[]>;
  /** Whether the task workspaces' sweep runs; taskWorkspaceRetentionOn by default (off). */
  workspaceRetention?: () => boolean;
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export function startUpkeep(deps: StartUpkeepDeps): void {
  const sweepLogsNow = () => {
    const retentionDays = deps.retentionDays();
    if (retentionDays === null) return;
    const candidates = deps.bots().flatMap((bot) => (bot.tasks ?? []).map((task) => ({
      threadId: task.threadId,
      closedAt: task.closedBy?.at ?? null,
      archivedAt: task.archivedAt ?? null,
      unread: task.unread === true,
      busy: deps.busy(bot.id, task.threadId),
      openDirectHandoff: deps.openDirectHandoff(task.threadId),
    })));
    const swept = (deps.sweepLogs ?? sweepThreadEventLogs)(candidates, retentionDays);
    if (swept > 0) console.log(`[retention] removed event logs for ${swept} idle thread(s) past ${retentionDays} day(s)`);
  };
  // Read lazily: the removals before a thread's turn take time, and a thread that wakes meanwhile must read busy.
  function* workspaceCandidates() {
    for (const bot of deps.bots()) {
      for (const task of bot.tasks ?? []) {
        yield {
          botId: bot.id,
          threadId: task.threadId,
          lastActiveAt: Math.max(task.updatedAt ?? task.createdAt ?? 0, task.closedBy?.at ?? 0, task.archivedAt ?? 0),
          unread: task.unread === true,
          busy: deps.busy(bot.id, task.threadId),
          openDirectHandoff: deps.openDirectHandoff(task.threadId),
        };
      }
    }
  }
  let sweepingWorkspaces = false;
  const sweepWorkspacesNow = async () => {
    if (sweepingWorkspaces || !(deps.workspaceRetention ?? taskWorkspaceRetentionOn)()) return;
    sweepingWorkspaces = true;
    try {
      const removed = await (deps.sweepWorkspaces ?? ((c) => sweepTaskWorkspaceBuildFolders(c)))(workspaceCandidates());
      if (removed.length > 0) console.log(`[retention] removed ${removed.length} dependency folder(s) from idle task workspaces`);
    } finally {
      sweepingWorkspaces = false;
    }
  };
  const sweepAll = () => {
    try {
      sweepLogsNow();
    } catch (error) {
      console.warn(`thread event log retention sweep failed: ${reason(error)}`);
    }
    sweepWorkspacesNow().catch((error: unknown) => console.warn(`task workspace retention sweep failed: ${reason(error)}`));
  };
  setImmediate(() => {
    try {
      const reclaimed = (deps.cleanupPartials ?? cleanupStaleAttachmentPartials)();
      if (reclaimed > 0) console.log(`reclaimed ${reclaimed} abandoned upload partial(s)`);
    } catch (error) {
      console.warn(`attachments: startup partial cleanup failed: ${reason(error)}`);
    }
    sweepAll();
  });
  setInterval(sweepAll, THREAD_LOG_RETENTION_SWEEP_MS).unref();
  // Busy: a turn runs, or an engine process lives on between turns (a kept-warm engine, the MCP servers it started), which
  // may run a program out of a cache entry.
  deps.caches?.start(() => (deps.enginesLive?.() ?? false) || deps.bots().some((bot) => (bot.tasks ?? []).some((task) => deps.busy(bot.id, task.threadId))));
}
