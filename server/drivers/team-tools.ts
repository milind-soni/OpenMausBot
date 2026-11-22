import type { ServerText } from "../../shared/server-text.ts";
import { noticeFailure } from "../chat-notices.ts";

/** Shown in the chat when an engine could not start the `agents` MCP server, a bot's only way to reach other bots. */
export const TEAM_TOOLS_FAILED = "This bot's team tools didn't connect, so it couldn't reach other bots this time. They reconnect on your next message.";

/** One MCP server's startup state, as Claude Code's `system/init` lists it in `mcp_servers` and
 * Codex's `mcpServer/startupStatus/updated` sends it: the `agents` server failed. */
export function teamToolsFailed(server: unknown): boolean {
  return serverFailed(server, "agents");
}

/** The same startup state for the `edu` server, the bot's Edu brain. */
export function eduMemoryFailed(server: unknown): boolean {
  return serverFailed(server, "edu");
}

function serverFailed(server: unknown, name: string): boolean {
  const record = server && typeof server === "object" ? server as { name?: unknown; status?: unknown } : null;
  return record?.name === name && record.status === "failed";
}

const EDU_NOTICE_EVERY_MS = 60 * 60 * 1000;
const eduNoticed = new Map<string, number>();

/** The quiet line for a turn whose `edu` server did not start, at most once an hour in a thread; null when this
 * thread already had it. The turn goes on without the Edu brain. */
export function eduMemoryNotice(threadId: string, now: number = Date.now()): { message: string; text: ServerText } | null {
  for (const [thread, at] of eduNoticed) if (now - at >= EDU_NOTICE_EVERY_MS) eduNoticed.delete(thread);
  if (eduNoticed.has(threadId)) return null;
  eduNoticed.set(threadId, now);
  return noticeFailure("chat.notice.eduMemoryFailed");
}

/** The servers of `custom` that Claude Code's `system/init` `mcp_servers` lists as failed, for `session.started`. */
export function failedCustomMcp(servers: unknown, custom: Readonly<Record<string, unknown>> | undefined): { mcpFailed?: string[] } {
  if (!Array.isArray(servers) || !custom) return {};
  const failed = servers.flatMap((server) => {
    const record = server && typeof server === "object" ? server as { name?: unknown; status?: unknown } : null;
    return typeof record?.name === "string" && record.status === "failed" && Object.hasOwn(custom, record.name) ? [record.name] : [];
  });
  return failed.length ? { mcpFailed: failed } : {};
}

/** The lines for one process's MCP startup states, as Codex's `mcpServer/startupStatus/updated` sends them: the team
 * tools' once per process, the Edu brain's at most once an hour in the thread. */
export function mcpStartupNotices(threadId: string) {
  let teamToolsNoticed = false;
  return {
    of(server: unknown): Array<{ message: string; text?: ServerText }> {
      if (!teamToolsNoticed && teamToolsFailed(server)) {
        teamToolsNoticed = true;
        return [{ message: TEAM_TOOLS_FAILED }];
      }
      const edu = eduMemoryFailed(server) ? eduMemoryNotice(threadId) : null;
      return edu ? [edu] : [];
    },
  };
}
