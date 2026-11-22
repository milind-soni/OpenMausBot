// A URL MCP server whose address answers MCP's first request with HTTP 404 or 405 is no MCP endpoint (a web page, a wrong
// path). Every engine fails it at every session start, and a server that failed there makes the conversation's engine
// start again from cold on its next turn (bot-box/broker-mcp.ts, drivers/codex.ts), so one such entry cost every turn of
// every bot that has it. It is left out of turns as a command server that does not start is (mcp-health.ts), the person
// hears it once, and it is tried again on its own. Only that definite answer turns a server off: a timeout, a refused key
// or an unreachable host may pass on the next try, and such a server stays in.
import { createHash } from "node:crypto";

import type { McpServerSpec, RemoteMcpSpec } from "../contracts.ts";
import { offNotice } from "../mcp-health.ts";
import { MAX_REMOTE_MCP_BYTES, McpHttpError, REMOTE_MCP_STARTUP_MS, RemoteMcpClient } from "../mcp-http.ts";

/** What an address that is no MCP endpoint answers MCP's initialize with. */
export const NOT_MCP_STATUSES: ReadonlySet<number> = new Set([404, 405]);
/** A server left out is tried again after this long, as a command server that did not start is. */
export const RECHECK_NOT_MCP_MS = 30 * 60_000;

type Bot = { id: string; name: string };
type UrlServer = { url: string; type?: string; headers?: Record<string, string> };
/** How the server answered MCP's first request: `status` when it answered with an HTTP error. */
export type UrlAnswer = { ok: true } | { ok: false; status?: number };

/** MCP's first request and nothing more: no tool list and no sign-in discovery, so a check reads nothing and costs the
 * server one request. */
export async function initializeAnswer(server: RemoteMcpSpec, timeoutMs = REMOTE_MCP_STARTUP_MS): Promise<UrlAnswer> {
  const client = new RemoteMcpClient(server, { maxBytes: MAX_REMOTE_MCP_BYTES });
  try {
    await client.initialize("OpenMausBot", AbortSignal.timeout(timeoutMs));
    return { ok: true };
  } catch (error) {
    return error instanceof McpHttpError && error.kind === "status" && error.status !== undefined ? { ok: false, status: error.status } : { ok: false };
  } finally {
    await client.close().catch(() => {});
  }
}

export interface McpUrlChecksDeps {
  /** The enabled URL servers, by name. */
  servers(): Record<string, UrlServer>;
  /** The bots whose turns start `name`. */
  users(name: string): Bot[];
  /** Sends the server MCP's first request (initializeAnswer). */
  probe(name: string, server: UrlServer): Promise<UrlAnswer>;
  /** Says it to the person, once. */
  tell(text: string, about: Bot): void;
  now?(): number;
}

/** The plain words a bot and the person get for a server left out. */
export const notMcpError = (status: number) =>
  `Its address answered HTTP ${status} to MCP's first request, so it is not an MCP server endpoint. Check the server's URL.`;

/** The server's identity for its check: where it is and how it is reached, so a fixed URL is checked again. */
const urlKey = (server: UrlServer) => createHash("sha256")
  .update(JSON.stringify([server.url, server.type ?? "http", Object.entries(server.headers ?? {}).sort()])).digest("hex").slice(0, 32);

export function createMcpUrlChecks(deps: McpUrlChecksDeps) {
  const now = deps.now ?? Date.now;
  const off = new Map<string, { key: string; at: number; error: string }>();
  const told = new Set<string>();
  const running = new Map<string, Promise<void>>();

  const check = (name: string): Promise<void> => {
    const server = deps.servers()[name];
    if (!server) { off.delete(name); return Promise.resolve(); }
    const key = urlKey(server);
    const id = `${name}\u0000${key}`;
    const pending = running.get(id);
    if (pending) return pending;
    const work = deps.probe(name, server).catch(() => null).then((result) => {
      const current = deps.servers()[name];
      if (!current || urlKey(current) !== key) return;
      const status = result && !result.ok ? result.status : undefined;
      if (status === undefined || !NOT_MCP_STATUSES.has(status)) {
        // Any other answer, a failure that may pass included, keeps the server in.
        off.delete(name);
        return;
      }
      off.set(name, { key, at: now(), error: notMcpError(status) });
      if (told.has(id)) return;
      told.add(id);
      const about = deps.users(name)[0];
      if (about) deps.tell(offNotice(name, null), about);
    }).finally(() => running.delete(id));
    running.set(id, work);
    return work;
  };

  /** The server's entry while it still describes the server as configured now. */
  const offNow = (name: string) => {
    const entry = off.get(name), server = deps.servers()[name];
    return entry && server && entry.key === urlKey(server) ? entry : undefined;
  };

  return {
    /** `mounted` without the URL servers that are no MCP endpoint; one due to be tried again is, in the background. */
    usable<T extends McpServerSpec>(mounted: Record<string, T>): Record<string, T> {
      return Object.fromEntries(Object.entries(mounted).filter(([name]) => {
        const entry = offNow(name);
        if (entry && now() - entry.at >= RECHECK_NOT_MCP_MS) void check(name);
        return !entry;
      }));
    },
    /** Which of `names` are left out, with why. */
    off(names: readonly string[]): Array<{ name: string; error: string }> {
      return names.flatMap((name) => {
        const entry = offNow(name);
        return entry ? [{ name, error: entry.error }] : [];
      });
    },
    /** Who a server is left out for, by bot id. */
    offFor(name: string): string[] {
      return offNow(name) ? deps.users(name).map((bot) => bot.id) : [];
    },
    /** The bot's AI reported these did not connect, or a server was added, changed or turned on: checked now. */
    check(names: readonly string[]): void {
      for (const name of names) if (deps.servers()[name]) void check(name);
    },
    /** In the background, every enabled URL server some bot's turns start. */
    checkAll(): void {
      for (const name of Object.keys(deps.servers())) if (deps.users(name).length) void check(name);
    },
    /** Settles once every check started so far has. */
    async settled(): Promise<void> {
      while (running.size) await Promise.all(running.values());
    },
  };
}

export type McpUrlChecks = ReturnType<typeof createMcpUrlChecks>;
