import { approvalModeFor } from "../../shared/approval-mode";
import { taskPatchFields } from "./model";
import type { Bot, BotAnnouncement, TaskUpdatePatch } from "./model";

/** One thread's optimistic task-settings write: the coalesced patch, the
 * serialized save chain, and the chain a send must await before it may
 * start work under those settings. */
interface TaskWriteEntry {
  botId: string;
  updatesDefault: boolean;
  promise: Promise<BotAnnouncement>;
  execution: Promise<unknown>;
  patch: TaskUpdatePatch;
}

export interface TaskWriteQueueOptions {
  /** Persist one thread's coalesced patch; resolves with the server's bot. */
  send: (botId: string, threadId: string, patch: TaskUpdatePatch) => Promise<BotAnnouncement>;
  /** Re-read the authoritative bot after a failed write. */
  reconcile: (botId: string) => Promise<BotAnnouncement | null>;
  /** Fold a server-authoritative bot back into state; the queue has already
   * overlaid its still-pending task writes onto it. */
  onAuthoritative: (bot: BotAnnouncement) => void;
  onError: (error: unknown) => void;
  /** Flush a bot's debounced profile lane (the bot-patch queue) and return
   * its server-authoritative bot, or null when nothing was queued. */
  flushBotLane: (botId: string) => Promise<BotAnnouncement | null>;
}

export interface TaskWriteQueue {
  /** A server bot with this queue's pending task patches overlaid onto it. */
  overlayBot: (bot: BotAnnouncement) => BotAnnouncement;
  /** Queue a task-settings write, serialized behind pending writes on the
   * same thread and behind same-bot default changes. */
  persist: (botId: string, threadId: string, patch: TaskUpdatePatch) => void;
  /** Block a send until its task saves and profile lanes have settled, and
   * reject when persisted settings drifted from what the send expected. */
  waitForExecutionSettings: (expectedBots: Bot[], threadId?: string) => Promise<void>;
  /** Undo a dispose. Exists for React StrictMode, whose dev-mode mount probe
   * runs the effect cleanup once against the SAME memoized queue. */
  revive: () => void;
  dispose: () => void;
}

/**
 * A per-thread task-settings lane: writes coalesce per thread, serialize
 * against same-bot default changes, and every settled write folds the
 * server's bot back while later edits stay optimistic. Sends await the lane
 * (plus each bot's profile lane) so work never starts under settings the
 * server has not confirmed.
 */
export function createTaskWriteQueue(options: TaskWriteQueueOptions): TaskWriteQueue {
  const taskWrites = new Map<string, TaskWriteEntry>();
  let disposed = false;

  const overlayBot = (bot: BotAnnouncement): BotAnnouncement => ({
    ...bot,
    tasks: bot.tasks?.map((task) => ({ ...task, ...taskPatchFields(taskWrites.get(task.threadId)?.patch ?? {}) })),
  });

  const persist = (botId: string, threadId: string, patch: TaskUpdatePatch) => {
    if (disposed) return;
    const previous = taskWrites.get(threadId);
    // A quick tab switch may queue two default changes on different threads.
    // Keep their order, and don't let a group send race either pending save.
    const sameBotWrites = [...taskWrites.values()].filter((write) => write.botId === botId);
    const defaults = patch.updateBotDefault || patch.approvalMode !== undefined
      ? sameBotWrites : sameBotWrites.filter((write) => write.updatesDefault);
    const promise = Promise.all([previous?.promise, ...defaults.map((write) => write.promise)].map((save) => save?.catch(() => {})))
      .then(() => options.send(botId, threadId, patch));
    // Later edits still get saved after an earlier failure, but a send
    // awaiting this batch must observe every rejected setting in it. A
    // successful folder move is not confirmation of a failed model change.
    const execution = Promise.all([previous?.execution, promise]);
    void execution.catch(() => {}); // handled by the write and send paths
    const pending: TaskWriteEntry = { botId, updatesDefault: Boolean(patch.updateBotDefault || previous?.updatesDefault), patch: { ...previous?.patch, ...patch }, promise, execution };
    taskWrites.set(threadId, pending);
    void pending.promise.then((bot) => {
      if (taskWrites.get(threadId) !== pending) return;
      taskWrites.delete(threadId);
      if (!disposed && bot) options.onAuthoritative(overlayBot(bot));
    }).catch((error) => {
      options.onError(error);
      // Block sends until authoritative settings have been restored. Do
      // not clear the failed write if reconciliation also fails or a newer
      // write supersedes it: those settings are still unconfirmed.
      if (taskWrites.get(threadId) === pending) {
        pending.patch = {};
        void options.reconcile(botId).then((bot) => {
          if (disposed || taskWrites.get(threadId) !== pending) return;
          if (bot) {
            options.onAuthoritative(overlayBot(bot));
            taskWrites.delete(threadId);
          }
        }).catch(() => {});
      }
    });
  };

  const waitForExecutionSettings = async (expectedBots: Bot[], threadId?: string) => {
    // Capture this send's task save before waiting on slower profile saves.
    // Reconciliation may clear a failed lane meanwhile; that must not turn
    // an already-waiting send into work under reverted settings.
    const taskWrite = threadId ? taskWrites.get(threadId)?.execution : undefined;
    const defaultWrites = [...taskWrites.values()].filter((write) => write.updatesDefault && expectedBots.some((bot) => bot.id === write.botId));
    await Promise.all([taskWrite, ...defaultWrites.map((write) => write.execution), ...expectedBots.map(async (expected) => {
      const persisted = await options.flushBotLane(expected.id);
      if (!persisted) return;
      const expectedSelection = expected.modelSelection;
      if (
        approvalModeFor(persisted) !== approvalModeFor(expected) ||
        persisted.modelSelection.instanceId !== expectedSelection.instanceId ||
        persisted.modelSelection.model !== expectedSelection.model ||
        persisted.modelSelection.effort !== expectedSelection.effort ||
        persisted.modelSelection.variant !== expectedSelection.variant
      ) {
        throw new Error("The approval level or model could not be saved, so this work was not started");
      }
    })]);
    if (threadId) {
      // A newer settings write can replace the lane entry while an awaited
      // execution runs; re-check after each await and resolve only once the
      // entry survives its own execution (or the lane has cleared).
      let awaited: Promise<unknown> | undefined;
      for (let pending = taskWrites.get(threadId); pending; pending = taskWrites.get(threadId)) {
        if (pending.execution === awaited) break;
        awaited = pending.execution;
        await pending.execution;
      }
    }
  };

  return {
    overlayBot,
    persist,
    waitForExecutionSettings,
    revive() {
      disposed = false;
    },
    dispose() {
      // In-flight saves cannot be aborted and their send-blocking semantics
      // must survive a StrictMode revive, so dispose only stops this queue
      // from accepting writes or folding results back after a real unmount.
      disposed = true;
    },
  };
}
