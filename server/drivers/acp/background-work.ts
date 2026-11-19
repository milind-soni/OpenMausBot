type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<any>;

/** Work an agent goes on with after its turn (a background subagent or shell command) and whose finish wakes a turn no
 * `session/prompt` asked for. The driver ends it when the person stops a turn, and when such a turn wakes between ours. */
export interface AcpBackgroundWork {
  /** Whether a session/update that arrives while no turn of ours runs is the agent working on its own. `sinceSettledMs` is how
   * long ago a turn of ours last settled; an update of that turn can still trail it. */
  wakes(update: Record<string, any> | undefined, sinceSettledMs?: number): boolean;
  /** The session a turn resumes: its stored cursor, or with none whatever ending the work left behind for this live session. */
  resumeCursor(cursor: unknown, live: string | null, session?: object): string | null;
  /** Ends the session's background work and any turn it woke, keeping its history. Never throws. Resolves false when the work
   * could not be ended and may still wake turns; the driver then closes the session's process. */
  end(session: { sessionId: string | null; cwd: string; initResult: any }, request: Request): Promise<boolean | void>;
}

/** The session/update kinds a turn streams; titles, usage, compaction and command lists are not one. */
export const TURN_UPDATES: ReadonlySet<string> = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/** A turn of ours can settle before its last updates arrive (a cancel timeout, a stuck turn, a failed prompt); an update this
 * soon after it is taken for that turn's tail, not a wake. A woken turn streams on past it. */
export const WAKE_GRACE_MS = 2_000;

const CLOSE_WAIT_MS = 10_000;

/** For an agent whose `session/close` ends the session's background work and whose `session/load` of the same id brings its
 * history back (grok 1.0.89): the session is closed and the thread's next turn loads it again, under the same id. An agent
 * that does not advertise `session/close` cannot end the work that way, so `end` reports it could not. */
export function closeEndsBackgroundWork(): AcpBackgroundWork {
  const closed = new WeakMap<object, string>();
  return {
    wakes: (update, sinceSettledMs = Infinity) => TURN_UPDATES.has(update?.sessionUpdate) && sinceSettledMs >= WAKE_GRACE_MS,
    resumeCursor: (cursor, live, session) =>
      typeof cursor === "string" ? cursor : live === null && session ? closed.get(session) ?? null : null,
    end: async (session, request) => {
      const sessionId = session.sessionId;
      if (!sessionId) return;
      if (!session.initResult?.agentCapabilities?.sessionCapabilities?.close) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await request("session/close", { sessionId }, CLOSE_WAIT_MS);
          closed.set(session, sessionId);
          session.sessionId = null;
          return true;
        } catch {
          // Tried again once; the caller hears of a second failure.
        }
      }
      return false;
    },
  };
}
