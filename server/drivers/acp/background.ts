// OpenCode 2.3+ and Qwen Code 1.0.0-preview.2 can start unsolicited turns when background jobs finish.
// session/cancel interrupts the current step but leaves the jobs intact. A fork copies history without the jobs.
// session/delete ends jobs on the original session. In Qwen they can take about a second to stop after it replies.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import { TURN_UPDATES, type AcpBackgroundWork } from "./background-work.ts";

/** A woken OpenCode turn's retry notice and the step after it are session_info_updates with this key
 * (packages/cli/src/acp); compaction and titles use others. */
const STEP_META = "opencode/retry";

/** `waitMs` bounds each fork/delete/close call; Qwen Code 1.0.0-preview.2 holds session/delete about 10 s. */
export function acpBackgroundWork(scope: readonly string[], waitMs = 10_000): AcpBackgroundWork {
  const dir = join(DATA_DIR, "acp-background-forks");
  const pathFor = (threadId: string, sessionId: string) => join(dir,
    createHash("sha256").update(JSON.stringify([...scope, threadId, sessionId])).digest("hex"));
  const deleted = new Set<string>();
  const forkFor = (threadId: string, sessionId: string) => {
    try {
      return readFileSync(pathFor(threadId, sessionId), "utf8") || null;
    } catch {
      return null;
    }
  };
  return {
    wakesDuringSetup: true,
    wakes: (update) => {
      const kind = update?.sessionUpdate;
      if (TURN_UPDATES.has(kind)) return true;
      const meta = update?._meta;
      return kind === "session_info_update" && meta !== null && typeof meta === "object" && STEP_META in meta;
    },
    resumeCursor: (threadId, cursor, live) => {
      let id = typeof cursor === "string" ? cursor : live !== null && forkFor(threadId, live) ? live : null;
      if (id === null) return null;
      const original = id;
      const visited = new Set<string>();
      while (!visited.has(id)) {
        visited.add(id);
        const fork = forkFor(threadId, id);
        if (!fork) return id;
        id = fork;
      }
      return original;
    },
    end: async (threadId, session, request) => {
      const sessionId = session.sessionId;
      if (!sessionId) return;
      const can = session.initResult?.agentCapabilities?.sessionCapabilities ?? {};
      const path = pathFor(threadId, sessionId);
      if (deleted.has(path)) return true;
      if (!can.delete) return false;
      const quietly = (method: string, params: unknown) => request(method, params, waitMs).catch(() => undefined);
      const deleteOriginal = async () => {
        await request("session/delete", { sessionId }, waitMs);
        deleted.add(path);
      };
      if (forkFor(threadId, sessionId)) {
        return deleteOriginal().then(() => true, () => false);
      }
      if (!can.fork) return false;
      let fork: unknown;
      try {
        fork = (await request("session/fork", { sessionId, cwd: session.cwd, mcpServers: [] }, waitMs))?.sessionId;
      } catch {
        return false;
      }
      if (typeof fork !== "string" || !fork || fork === sessionId) return false;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileAtomic(path, fork, { mode: 0o600 });
      } catch {
        await quietly("session/delete", { sessionId: fork });
        return false;
      }
      let confirmed = false;
      try {
        await deleteOriginal();
        confirmed = true;
      } catch (error) {
        // A lost response can leave the original deleted. Keep the fork unless ACP explicitly rejected the request.
        if (typeof (error as { code?: unknown } | null)?.code === "number") {
          try { rmSync(path); } catch { return false; }
          await quietly("session/delete", { sessionId: fork });
          return false;
        }
      }
      // The fork was opened without the bot's MCP servers: the next turn loads it with them.
      await quietly("session/close", { sessionId: fork });
      return confirmed;
    },
  };
}
