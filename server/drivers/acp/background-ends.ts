import type { AcpBackgroundWork } from "./background-work.ts";
import type { AcpSession } from "./turn-state.ts";

/** Ends a thread's background work once at a time. A stop that cannot be confirmed keeps the thread gated until it is. */
export function backgroundEnds(work: AcpBackgroundWork | undefined, stop: (threadId: string, session: AcpSession, forced: boolean) => Promise<boolean>) {
  const ends = new Map<string, Promise<void>>(), unstopped = new Map<string, AcpSession>();
  return {
    settled: (threadId: string) => ends.get(threadId),
    end(threadId: string, session: AcpSession) {
      if (!work || session.child.exitCode !== null) return;
      if (ends.has(threadId)) return ends.get(threadId);
      const cleanup = work.end(threadId, session, (method, params, timeoutMs) => session.host.request(null, method, params, timeoutMs))
        .then(async (complete) => { if (complete === false && !await stop(threadId, session, true)) unstopped.set(threadId, session); }).finally(() => ends.delete(threadId));
      ends.set(threadId, cleanup);
      return cleanup;
    },
    async requireStopped(threadId: string, provider: string) {
      await ends.get(threadId);
      const stuck = unstopped.get(threadId);
      if (stuck && !await stop(threadId, stuck, true)) throw new Error(`${provider} is still running background work that could not be stopped. Try again shortly.`);
      unstopped.delete(threadId);
    },
    /** An update for a session still loading is replayed history, so during setup only the loaded session's own update is a wake. */
    wake(threadId: string, session: AcpSession, update: Record<string, any> | undefined, sessionId: unknown, turn?: { state: { backgroundWoke?: boolean } }) {
      if (!work?.wakes(update, Date.now() - (session.settledAt ?? 0))) return;
      if (turn && !(work.wakesDuringSetup && session.sessionId && sessionId === session.sessionId && sessionId !== session.loadingSessionId)) return;
      if (turn) turn.state.backgroundWoke = true;
      this.end(threadId, session);
    },
    async requireNoWake(threadId: string, turn: { state: { backgroundWoke?: boolean } }, provider: string) {
      if (!turn.state.backgroundWoke) return;
      await ends.get(threadId);
      throw new Error(`${provider} resumed background work during setup. Send the message again to continue.`);
    },
    async loading<T>(session: AcpSession, sessionId: string, run: () => Promise<T>): Promise<T> {
      session.loadingSessionId = sessionId;
      try { return await run(); } finally { session.loadingSessionId = undefined; }
    },
    cursor: (threadId: string, stored: unknown, session: AcpSession) => work
      ? work.resumeCursor(threadId, stored, session.sessionId, session)
      : typeof stored === "string" ? stored : null,
  };
}
