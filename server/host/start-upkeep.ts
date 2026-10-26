// The attachments' and the thread logs' upkeep. Both are safe beside requests: an upload in flight keeps its partial
// and its reservation, and a busy, unread or handed-off thread keeps its log. So the first pass runs once the server
// answers, not before it listens, and the logs' sweep then runs once a day.
import { cleanupStaleAttachmentPartials } from "../attachments.ts";
import type { BotRecord } from "../store.ts";
import { sweepThreadEventLogs } from "../thread-retention.ts";

export const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

export interface StartUpkeepDeps {
  bots: () => ReadonlyArray<Pick<BotRecord, "id" | "tasks">>;
  retentionDays: () => number | null;
  busy: (botId: string, threadId: string) => boolean;
  openDirectHandoff: (threadId: string) => boolean;
  cleanupPartials?: () => number;
  sweepLogs?: typeof sweepThreadEventLogs;
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
  setImmediate(() => {
    try {
      const reclaimed = (deps.cleanupPartials ?? cleanupStaleAttachmentPartials)();
      if (reclaimed > 0) console.log(`reclaimed ${reclaimed} abandoned upload partial(s)`);
    } catch (error) {
      console.warn(`attachments: startup partial cleanup failed: ${reason(error)}`);
    }
    try {
      sweepLogsNow();
    } catch (error) {
      console.warn(`thread event log retention sweep failed: ${reason(error)}`);
    }
  });
  setInterval(sweepLogsNow, THREAD_LOG_RETENTION_SWEEP_MS).unref();
}
