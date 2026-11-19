type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<any>;

/** Work an agent goes on with after its turn (a background subagent or shell command) and whose finish wakes a turn no
 * `session/prompt` asked for. The driver ends it when the person stops a turn, and when such a turn wakes between ours. */
export interface AcpBackgroundWork {
  /** Whether a session/update that arrives while no turn of ours runs is the agent working on its own. */
  wakes(update: Record<string, any> | undefined): boolean;
  /** The session a turn resumes: its stored cursor, or with none whatever ending the work left behind for this live session. */
  resumeCursor(cursor: unknown, live: string | null, session?: object): string | null;
  /** Ends the session's background work and any turn it woke, keeping its history. Never throws. */
  end(session: { sessionId: string | null; cwd: string; initResult: any }, request: Request): Promise<void>;
}

/** The session/update kinds a turn streams; titles, usage, compaction and command lists are not one. */
export const TURN_UPDATES: ReadonlySet<string> = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

const CLOSE_WAIT_MS = 10_000;

/** For an agent whose `session/close` ends the session's background work and whose `session/load` of the same id brings its
 * history back (grok 1.0.89): the session is closed and the thread's next turn loads it again, under the same id. */
export function closeEndsBackgroundWork(): AcpBackgroundWork {
  const closed = new WeakMap<object, string>();
  return {
    wakes: (update) => TURN_UPDATES.has(update?.sessionUpdate),
    resumeCursor: (cursor, live, session) =>
      typeof cursor === "string" ? cursor : live === null && session ? closed.get(session) ?? null : null,
    end: async (session, request) => {
      const sessionId = session.sessionId;
      if (!sessionId || !session.initResult?.agentCapabilities?.sessionCapabilities?.close) return;
      try {
        await request("session/close", { sessionId }, CLOSE_WAIT_MS);
        closed.set(session, sessionId);
        session.sessionId = null;
      } catch {
        // The session keeps its background work, as before.
      }
    },
  };
}
