// OpenCode 2.3+ keeps work going after its turn: a shell command still running at its timeout moves to the background
// (2.3.1), subagents always run in the background (2.3.0), and each one's finish wakes a turn no session/prompt asked
// for. session/cancel and session/close only interrupt the running step; OpenCode ends a session's background jobs only
// when the session is deleted (core Session.remove: interrupt, wait for idle, cancel its jobs). So when a person stops a
// turn, or a turn wakes between ours (it would run tools unseen, with Full access's grants), the session is forked to
// keep its history (core Session.fork copies its messages, not its jobs or queued notices), then the original is deleted.
// The thread's next turn loads the fork. An OpenCode without session/fork and session/delete is left as it is.

import { TURN_UPDATES, type AcpBackgroundWork } from "./background-work.ts";

const WAIT_MS = 10_000;
/** A woken turn's retry notice and the step after it are session_info_updates with this key (packages/cli/src/acp);
 * compaction and titles use others. */
const STEP_META = "opencode/retry";

export function openCodeBackgroundWork(): AcpBackgroundWork {
  const forkedTo = new Map<string, string>();
  return {
    wakes: (update) => {
      const kind = update?.sessionUpdate;
      if (TURN_UPDATES.has(kind)) return true;
      const meta = update?._meta;
      return kind === "session_info_update" && meta !== null && typeof meta === "object" && STEP_META in meta;
    },
    resumeCursor: (cursor, live) => {
      let id = typeof cursor === "string" ? cursor : live !== null && forkedTo.has(live) ? live : null;
      if (id === null) return null;
      for (let hops = 0; forkedTo.has(id) && hops < 64; hops++) id = forkedTo.get(id)!;
      return id;
    },
    end: async (session, request) => {
      const sessionId = session.sessionId;
      if (!sessionId || forkedTo.has(sessionId)) return;
      const can = session.initResult?.agentCapabilities?.sessionCapabilities ?? {};
      if (!can.fork || !can.delete) return;
      const quietly = (method: string, params: unknown) => request(method, params, WAIT_MS).then(() => true, () => false);
      let fork: unknown;
      try {
        fork = (await request("session/fork", { sessionId, cwd: session.cwd, mcpServers: [] }, WAIT_MS))?.sessionId;
      } catch {
        return;
      }
      if (typeof fork !== "string" || !fork) return;
      if (!await quietly("session/delete", { sessionId })) {
        await quietly("session/delete", { sessionId: fork });
        return;
      }
      forkedTo.set(sessionId, fork);
      // The fork was opened without the bot's MCP servers: the next turn loads it with them.
      await quietly("session/close", { sessionId: fork });
    },
  };
}
