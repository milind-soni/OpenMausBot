// OpenCode 2.3+ and Qwen Code 1.0.0-preview.2 can start unsolicited turns when background jobs finish.
// session/cancel interrupts the current step but leaves the jobs intact. A fork copies history without the jobs.
// session/delete ends jobs on the original session. In Qwen they can take about a second to stop after it replies.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<any>;

/** A woken OpenCode turn's retry notice and the step after it are session_info_updates with this key
 * (packages/cli/src/acp); compaction and titles use others. */
const STEP_META = "opencode/retry";
const TURN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

export interface AcpBackgroundWork {
  /** Whether a session/update that arrives while no turn of ours runs is the agent working on its own. */
  wakes(update: Record<string, any> | undefined): boolean;
  /** The session a turn resumes: its stored cursor, or with none the live session once it was forked, after any forks. */
  resumeCursor(threadId: string, cursor: unknown, live: string | null): string | null;
  /** Ends the session's background jobs and any turn they woke, keeping its history in a fork. Never throws. */
  end(threadId: string, session: { sessionId: string | null; cwd: string; initResult: any }, request: Request): Promise<void>;
}

/** `waitMs` bounds each fork/delete/close call; Qwen Code 1.0.0-preview.2 holds session/delete about 10 s. */
export function acpBackgroundWork(scope: readonly string[], waitMs = 10_000): AcpBackgroundWork {
  const dir = join(DATA_DIR, "acp-background-forks");
  const pathFor = (threadId: string, sessionId: string) => join(dir,
    createHash("sha256").update(JSON.stringify([...scope, threadId, sessionId])).digest("hex"));
  const forkFor = (threadId: string, sessionId: string) => {
    try {
      return readFileSync(pathFor(threadId, sessionId), "utf8") || null;
    } catch {
      return null;
    }
  };
  return {
    wakes: (update) => {
      const kind = update?.sessionUpdate;
      if (TURN_UPDATES.has(kind)) return true;
      const meta = update?._meta;
      return kind === "session_info_update" && meta !== null && typeof meta === "object" && STEP_META in meta;
    },
    resumeCursor: (threadId, cursor, live) => {
      let id = typeof cursor === "string" ? cursor : live !== null && forkFor(threadId, live) ? live : null;
      if (id === null) return null;
      for (let hops = 0; hops < 64; hops++) {
        const fork = forkFor(threadId, id);
        if (!fork) break;
        id = fork;
      }
      return id;
    },
    end: async (threadId, session, request) => {
      const sessionId = session.sessionId;
      if (!sessionId || forkFor(threadId, sessionId)) return;
      const can = session.initResult?.agentCapabilities?.sessionCapabilities ?? {};
      if (!can.fork || !can.delete) return;
      const quietly = (method: string, params: unknown) => request(method, params, waitMs).catch(() => undefined);
      let fork: unknown;
      try {
        fork = (await request("session/fork", { sessionId, cwd: session.cwd, mcpServers: [] }, waitMs))?.sessionId;
      } catch {
        return;
      }
      if (typeof fork !== "string" || !fork || fork === sessionId) return;
      const path = pathFor(threadId, sessionId);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileAtomic(path, fork, { mode: 0o600 });
      } catch {
        await quietly("session/delete", { sessionId: fork });
        return;
      }
      try {
        await request("session/delete", { sessionId }, waitMs);
      } catch (error) {
        // A lost response can leave the original deleted. Keep the fork unless ACP explicitly rejected the request.
        if (typeof (error as { code?: unknown } | null)?.code === "number") {
          try { rmSync(path); } catch { return; }
          await quietly("session/delete", { sessionId: fork });
          return;
        }
      }
      // The fork was opened without the bot's MCP servers: the next turn loads it with them.
      await quietly("session/close", { sessionId: fork });
    },
  };
}
