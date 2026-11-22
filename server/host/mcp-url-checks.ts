// A URL MCP server whose address answers MCP's first request with HTTP 405 is no MCP endpoint (a web page that takes no
// POST). Every engine fails it at every session start, and a server that failed there makes the conversation's engine
// start again from cold on its next turn (bot-box/broker-mcp.ts, drivers/codex.ts), so one such entry cost every turn of
// every bot that has it. It is left out of turns as a command server that does not start is (mcp-health.ts), the person
// hears it once (across restarts), and it is tried again on its own. Only that definite answer turns a server off: a
// timeout, a refused key, a redirect or an unreachable host may pass on the next try, and such a server stays in; one that
// refuses the POST but answers a GET with an event stream speaks MCP's older HTTP+SSE transport and stays in too. Where
// bots' turns are boxed the check goes through the credential broker, as their turns do, so the egress rules apply; it
// never follows a redirect, so a server's keys never reach another address.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";
import type { McpServerSpec, RemoteMcpSpec } from "../contracts.ts";
import { offNotice } from "../mcp-health.ts";
import { MAX_REMOTE_MCP_BYTES, McpHttpError, REMOTE_MCP_STARTUP_MS, RemoteMcpClient } from "../mcp-http.ts";

/** What an address that is no MCP endpoint answers MCP's initialize with. Not 404: a server that hides behind it until
 * signed in would be turned off by a check that sends no sign-in. */
export const NOT_MCP_STATUSES: ReadonlySet<number> = new Set([405]);
/** A server left out is tried again after this long, as a command server that did not start is. */
export const RECHECK_NOT_MCP_MS = 30 * 60_000;
/** An engine reports a failed server at every session start: one check per server address in this long is enough. */
export const RECHECK_AFTER_ENGINE_MS = 10 * 60_000;

type Bot = { id: string; name: string };
type UrlServer = { url: string; type?: string; headers?: Record<string, string> };
/** How the server answered MCP's first request: `status` when it answered with an HTTP error. */
export type UrlAnswer = { ok: true } | { ok: false; status?: number };

/** A fetch that never follows a redirect: the server's headers, its keys among them, would go along to another address.
 * A redirect is then an answer like any other HTTP status, which keeps a server in. */
export const withoutRedirects = (base: typeof fetch = fetch): typeof fetch => (input, init) => base(input, { ...init, redirect: "manual" });

/** MCP's backwards-compatibility rule for an address that refuses the POST: a server of the older HTTP+SSE transport
 * answers a GET with an event stream ("sse"). A GET that is answered with anything else is a plain page ("not"); one that
 * fails, is refused or redirects tells nothing ("unknown"). */
async function speaksSse(server: UrlServer, fetchImpl: typeof fetch, signal: AbortSignal): Promise<"sse" | "not" | "unknown"> {
  const stop = new AbortController();
  try {
    const response = await fetchImpl(server.url, {
      method: "GET", headers: { ...server.headers, accept: "text/event-stream" }, signal: AbortSignal.any([signal, stop.signal]),
    });
    if (!response.ok) return "unknown";
    // Media types are case-insensitive (RFC 9110).
    return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream") ? "sse" : "not";
  } catch {
    return "unknown";
  } finally {
    stop.abort();
  }
}

/** MCP's first request and nothing more: no tool list and no sign-in discovery, so a check reads nothing and costs the
 * server a request or two. `fetch`: how to reach it (a bot's broker); never one that follows redirects. */
export async function initializeAnswer(server: RemoteMcpSpec, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<UrlAnswer> {
  const fetchImpl = options.fetch ?? withoutRedirects();
  const signal = AbortSignal.timeout(options.timeoutMs ?? REMOTE_MCP_STARTUP_MS);
  const client = new RemoteMcpClient(server, { maxBytes: MAX_REMOTE_MCP_BYTES, fetch: fetchImpl });
  try {
    await client.initialize("OpenMausBot", signal);
    return { ok: true };
  } catch (error) {
    const status = error instanceof McpHttpError && error.kind === "status" ? error.status : undefined;
    if (status !== undefined && NOT_MCP_STATUSES.has(status) && server.type !== "sse") {
      const sse = await speaksSse(server, fetchImpl, signal);
      // An inconclusive GET is no answer either way: an included server stays in, an excluded one stays out.
      if (sse !== "not") return sse === "sse" ? { ok: true } : { ok: false };
    }
    return status !== undefined ? { ok: false, status } : { ok: false };
  } finally {
    await client.close().catch(() => {});
  }
}

export interface McpUrlChecksDeps {
  /** The enabled URL servers the organisation's policy allows, by name. */
  servers(): Record<string, UrlServer>;
  /** The bots whose turns start `name`. */
  users(name: string): Bot[];
  /** Sends the server MCP's first request (initializeAnswer). */
  probe(name: string, server: UrlServer): Promise<UrlAnswer>;
  /** Says it to the person, once. */
  tell(text: string, about: Bot): void;
  /** Where the servers the person was told about are kept, so a restart does not tell them again. */
  file?: string;
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
  if (deps.file) {
    try {
      const saved = JSON.parse(readFileSync(deps.file, "utf8")) as { told?: unknown };
      if (Array.isArray(saved.told)) for (const id of saved.told) if (typeof id === "string") told.add(id);
    } catch {}
  }
  const saveTold = () => {
    if (!deps.file) return;
    // Only servers still configured as they were told about: a changed or removed one is told about afresh.
    const current = new Set(Object.entries(deps.servers()).map(([name, server]) => `${name}\u0000${urlKey(server)}`));
    for (const id of told) if (!current.has(id)) told.delete(id);
    try { writeFileAtomic(deps.file, JSON.stringify({ told: [...told] }), { mode: 0o600 }); } catch (error) { console.warn("[mcp] could not save URL server checks:", error); }
  };
  const checkedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();

  const check = (name: string, force: boolean): Promise<void> => {
    const server = deps.servers()[name];
    if (!server) { off.delete(name); return Promise.resolve(); }
    const key = urlKey(server);
    const id = `${name}\u0000${key}`;
    const pending = running.get(id);
    if (pending) return pending;
    const last = checkedAt.get(id);
    if (!force && last !== undefined && now() - last < RECHECK_AFTER_ENGINE_MS) return Promise.resolve();
    checkedAt.set(id, now());
    const work = deps.probe(name, server).catch((): UrlAnswer => ({ ok: false })).then((answer) => {
      const current = deps.servers()[name];
      if (!current || urlKey(current) !== key) return;
      if (answer.ok) {
        off.delete(name);
        return;
      }
      if (answer.status === undefined || !NOT_MCP_STATUSES.has(answer.status)) {
        // An answer that is no MCP answer (a timeout, a refusal) proves nothing either way: a server left out stays out
        // until it answers as MCP, so it does not flip in and out on a busy computer; one in stays in.
        const entry = off.get(name);
        if (entry?.key === key) entry.at = now();
        return;
      }
      off.set(name, { key, at: now(), error: notMcpError(answer.status) });
      if (told.has(id)) return;
      told.add(id);
      saveTold();
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
        if (entry && now() - entry.at >= RECHECK_NOT_MCP_MS) void check(name, true);
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
    /** A server was added, changed or turned on: checked now. */
    changed(names: readonly string[]): void {
      for (const name of names) if (deps.servers()[name]) void check(name, true);
    },
    /** The bot's AI reported these did not connect: each is checked, at most once per address in RECHECK_AFTER_ENGINE_MS. */
    engineFailed(names: readonly string[]): void {
      for (const name of names) if (deps.servers()[name]) void check(name, false);
    },
    /** In the background, every enabled URL server some bot's turns start. */
    checkAll(): void {
      for (const name of Object.keys(deps.servers())) if (deps.users(name).length) void check(name, false);
    },
    /** Settles once every check started so far has. */
    async settled(): Promise<void> {
      while (running.size) await Promise.all(running.values());
    },
  };
}

export type McpUrlChecks = ReturnType<typeof createMcpUrlChecks>;
