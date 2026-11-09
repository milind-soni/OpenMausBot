// A conversation shown working while nothing runs for it holds every message and hand-off queued behind it, and no turn's
// end will ever free it. A person's Stop frees one at once and the turn watchdog frees one nobody stops. A turn an engine
// has, or is being handed, is left to its own end, so that turn's late events can never settle a newer one.
import type { Store } from "../store.ts";

export interface IdleThreadsDeps {
  store: Pick<Store, "bots" | "tasks" | "taskByThread" | "setTaskActivity">;
  /** Each thread's direct turn dispatch claim: "setup" before any engine has the turn, "dispatching" while one is handed it. */
  claims: ReadonlyMap<string, { phase: "setup" | "dispatching" }>;
  /** Each thread's direct turn generation. */
  generations: ReadonlyMap<string, string>;
  /** An engine has the thread's turn, or that turn's end is still settling. */
  engineTurn(threadId: string): boolean;
  /** Ends what the harness keeps for a turn on the thread: its watch, follow-ups, resources and screen. */
  settle(botId: string, threadId: string): void;
  drain(): void;
}

export function createIdleThreads(deps: IdleThreadsDeps) {
  const { store } = deps;
  const engineHolds = (threadId: string) => deps.claims.get(threadId)?.phase === "dispatching" || deps.engineTurn(threadId);
  const held = (threadId: string) => deps.claims.has(threadId) || engineHolds(threadId);

  function free(botId: string, threadId: string): void {
    if (held(threadId) || !store.taskByThread(botId, threadId)?.busy) return;
    deps.settle(botId, threadId);
    store.setTaskActivity(botId, threadId, "idle");
    deps.drain();
  }

  return {
    free,
    /** The conversations shown working that nothing holds but, maybe, a watched turn. */
    unheld(): Array<{ threadId: string; botId: string }> {
      return store.bots.flatMap((bot) => store.tasks(bot.id).flatMap((task) => (task.busy && !held(task.threadId) ? [{ threadId: task.threadId, botId: bot.id }] : [])));
    },
    /** Read before a Stop's interrupt drops the thread's dispatch claim. What it returns frees the thread once interrupted,
     * unless an engine had the turn or another turn began meanwhile. */
    stopping(botId: string, threadId: string): () => void {
      const generation = deps.generations.get(threadId);
      if (engineHolds(threadId)) return () => {};
      return () => {
        if (deps.generations.get(threadId) === generation) free(botId, threadId);
      };
    },
  };
}
