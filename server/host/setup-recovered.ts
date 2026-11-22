// A setup failure (an engine signed out or out of credits) marks its conversation "dead", and one dead conversation makes
// the whole bot read "unavailable — needs setup" to its teammates (peer-roster.ts), in the app and in reports, until that
// same conversation runs again. A later turn of the bot that its engine answered shows that engine's setup works now, so
// the label goes with it, for the conversations marked before that turn started on the same engine. Never for:
// - a conversation on another engine: that engine may still be signed out;
// - a turn saved steps answered with no engine call (saved-steps/dispatch.ts): it proves nothing about the engine;
// - a turn the person stopped;
// - a mark made after the succeeding turn started: that turn began before the sign-in lapsed.
import type { Store } from "../store.ts";

/** server/index.ts parks this in lastInstanceId when a conversation was carried in from elsewhere: no engine. */
const EXTERNAL_CONTEXT = "__openmaus_external_context__:";

type Task = { lastInstanceId?: string; modelSelection?: { instanceId: string } };
type Turn = { replayed: boolean; stopped: boolean };

export function createSetupRecovery(store: Pick<Store, "bot" | "setTaskActivity">, now: () => number = Date.now) {
  /** When each conversation was marked dead, by bot and thread. Marks do not outlive the server (store.ts resets them). */
  const markedAt = new Map<string, number>();
  const key = (botId: string, threadId: string) => `${botId}\u0000${threadId}`;
  return {
    /** A setup failure marked this conversation dead (server/index.ts, runtime.error). */
    failed(botId: string, threadId: string): void {
      markedAt.set(key(botId, threadId), now());
    },
    /** A turn of the bot completed successfully in this conversation. */
    succeeded(botId: string, threadId: string, turn: Turn): void {
      if (turn.replayed || turn.stopped) return;
      const bot = store.bot(botId);
      const done = bot?.tasks?.find((task) => task.threadId === threadId);
      const startedAt = done?.turnStartedAt;
      if (!bot || !done || startedAt === undefined) return;
      // The engine a turn was last sent to (a stand-in after a failover included), else the one the conversation is set to.
      const engineOf = (task: Task) => task.lastInstanceId && !task.lastInstanceId.startsWith(EXTERNAL_CONTEXT)
        ? task.lastInstanceId : (task.modelSelection ?? bot.modelSelection).instanceId;
      const engine = engineOf(done);
      for (const task of bot.tasks ?? []) {
        if (task.activity !== "dead" || engineOf(task) !== engine) continue;
        if ((markedAt.get(key(botId, task.threadId)) ?? 0) >= startedAt) continue;
        markedAt.delete(key(botId, task.threadId));
        store.setTaskActivity(botId, task.threadId, "idle");
      }
    },
  };
}

export type SetupRecovery = ReturnType<typeof createSetupRecovery>;
