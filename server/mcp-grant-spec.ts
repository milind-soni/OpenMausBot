// What a saved "Always allow" for an MCP tool is tied to on its server: the server as config.json holds it. A Vault key is
// there as its reference (`vault:<id>`), never its value, and the restart count is not there at all, so a new key value or
// a restart leaves every saved grant in place, while a changed command, argument, variable, address or header ends it.
import { createHash } from "node:crypto";

import type { McpServerSpec } from "./contracts.ts";
import { MCP_RESTART_ENV } from "./mcp-app-catalog.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { providerToolAllowKey } from "./provider-tool-allow.ts";
import type { GrantRewrite } from "./always-allow.ts";

const PREFIX = "provider-tool:";
/** A restart count an earlier version may have saved a grant under: counted since the app started, so it stays small. */
const EARLIER_RESTARTS = 20;

/** The server a grant names, from its config.json entry; null when that entry is not a server. */
export function storedGrantSpec(name: string, raw: unknown): McpServerSpec | null {
  const parsed = parseStoredMcpServer(name, raw);
  if (!parsed.ok) return null;
  return isRemoteMcpServer(parsed.server)
    ? { type: parsed.server.type, url: parsed.server.url, headers: parsed.server.headers }
    : { command: parsed.server.command, args: parsed.server.args, env: parsed.server.env };
}

const fingerprint = (spec: unknown): string => createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);

/** `value` with every object's names in order, as one earlier version wrote a server before fingerprinting it. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, sorted(item)]));
  return value;
}

/** The fingerprints earlier versions gave this server: of it as started, its Vault keys read, at each restart count,
 * with its names as written and in order (both were shipped).
 * Security: made from key values only to compare with a saved one; none is kept, logged or returned to a caller outside. */
function earlierFingerprints(started: McpServerSpec): Set<string> {
  const both = (spec: unknown): string[] => [fingerprint(spec), fingerprint(sorted(spec))];
  if (!("command" in started)) return new Set(both(started));
  const { [MCP_RESTART_ENV]: _restarts, ...env } = started.env;
  const prints = new Set(both({ ...started, env }));
  for (let count = 1; count <= EARLIER_RESTARTS; count += 1) for (const print of both({ ...started, env: { ...env, [MCP_RESTART_ENV]: String(count) } })) prints.add(print);
  return prints;
}

/** A server a bot's turn starts: as a grant names it now, and as the turn starts it. */
export interface GrantServer { names: McpServerSpec; started: McpServerSpec }

/** What tells one set of servers from another, so a bot whose servers are as they were is not gone over again. Kept in
 * memory only: a hash, as the servers as started hold key values. */
export const grantServersMark = (servers: Record<string, GrantServer>): string => createHash("sha256").update(JSON.stringify(servers)).digest("hex");

/** Moves the grants an earlier version saved for one of `servers` to that server's key now: each list it is given comes
 * back moved, or null when nothing in it moved. A key moves only when it is, to the letter, the key that version gave the
 * same tool on the same server as it is set up now: only its fingerprint changes, so it reaches no other bot, AI, server or
 * tool than it did. One mover serves all of a bot's lists: a server's fingerprints are made once, when a saved key first
 * names it, and each distinct key is worked out once, so the cost follows the keys that differ, not the threads. */
export function grantMover(servers: Record<string, GrantServer>): GrantRewrite {
  const earlier = new Map<string, Set<string>>();
  const known = new Map<string, string>();
  const moveOne = (key: string): string => {
    const cut = key.lastIndexOf(":");
    if (!key.startsWith(PREFIX) || cut < PREFIX.length) return key;
    const body = key.slice(PREFIX.length, cut), print = key.slice(cut + 1);
    for (const [name, server] of Object.entries(servers)) {
      const marker = `:${name}:`;
      for (let at = body.indexOf(marker); at > 0; at = body.indexOf(marker, at + 1)) {
        let prints = earlier.get(name);
        if (!prints) earlier.set(name, prints = earlierFingerprints(server.started));
        if (!prints.has(print)) continue;
        const now = providerToolAllowKey(body.slice(0, at), `mcp__${name}__${body.slice(at + marker.length)}`, server.names);
        if (now && now !== key && now.slice(0, now.lastIndexOf(":")) === key.slice(0, cut)) return now;
      }
    }
    return key;
  };
  return (keys) => {
    let moved = false;
    const next = keys.map((key) => {
      let now = known.get(key);
      if (now === undefined) known.set(key, now = moveOne(key));
      moved ||= now !== key;
      return now;
    });
    return moved ? [...new Set(next)] : null;
  };
}

/** One list, moved (see grantMover), or null when nothing in it moved. */
export const movedGrantKeys = (keys: readonly string[], servers: Record<string, GrantServer>): string[] | null => grantMover(servers)(keys);

interface GrantStore { rewriteGrants(botId: string, rewrite: GrantRewrite): boolean }

/** Applies `move` to everything a bot's grants are read from: the bot and each of its threads, in one save, and the turn
 * now starting. */
export function moveSavedGrants(store: GrantStore, live: { id: string; alwaysAllow?: string[] }, move: GrantRewrite): void {
  store.rewriteGrants(live.id, move);
  const turn = live.alwaysAllow ? move(live.alwaysAllow) : null;
  if (turn) live.alwaysAllow = turn;
}
