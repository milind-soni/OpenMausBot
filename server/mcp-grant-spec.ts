// What a saved "Always allow" for an MCP tool is tied to on its server: the server as config.json holds it. A Vault key is
// there as its reference (`vault:<id>`), never its value, and the restart count is not there at all, so a new key value or
// a restart leaves every saved grant in place, while a changed command, argument, variable, address or header ends it.
import { createHash } from "node:crypto";

import type { McpServerSpec } from "./contracts.ts";
import { MCP_RESTART_ENV } from "./mcp-app-catalog.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { providerToolAllowKey } from "./provider-tool-allow.ts";

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

/** The fingerprints earlier versions gave this server: of it as started, its Vault keys read, at each restart count.
 * Security: made from key values only to compare with a saved one; none is kept, logged or returned to a caller outside. */
function earlierFingerprints(started: McpServerSpec): Set<string> {
  if (!("command" in started)) return new Set([fingerprint(started)]);
  const { [MCP_RESTART_ENV]: _restarts, ...env } = started.env;
  const prints = new Set([fingerprint({ ...started, env })]);
  for (let count = 1; count <= EARLIER_RESTARTS; count += 1) prints.add(fingerprint({ ...started, env: { ...env, [MCP_RESTART_ENV]: String(count) } }));
  return prints;
}

/** A server a bot's turn starts: as a grant names it now, and as the turn starts it. */
export interface GrantServer { names: McpServerSpec; started: McpServerSpec }

/** `keys` with each grant an earlier version saved for one of `servers` moved to that server's key now, or null when none
 * moved. A key moves only when it is, to the letter, the key that version gave the same tool on the same server as it is
 * set up now: only its fingerprint changes, so it reaches no other bot, AI, server or tool than it did. */
export function movedGrantKeys(keys: readonly string[], servers: Record<string, GrantServer>): string[] | null {
  const earlier = new Map<string, Set<string>>();
  let moved = false;
  const next = keys.map((key) => {
    const cut = key.lastIndexOf(":");
    if (!key.startsWith(PREFIX) || cut < PREFIX.length) return key;
    const body = key.slice(PREFIX.length, cut);
    for (const [name, server] of Object.entries(servers)) {
      const marker = `:${name}:`;
      for (let at = body.indexOf(marker); at > 0; at = body.indexOf(marker, at + 1)) {
        const now = providerToolAllowKey(body.slice(0, at), `mcp__${name}__${body.slice(at + marker.length)}`, server.names);
        if (!now || now === key || now.slice(0, now.lastIndexOf(":")) !== key.slice(0, cut)) continue;
        let prints = earlier.get(name);
        if (!prints) earlier.set(name, prints = earlierFingerprints(server.started));
        if (!prints.has(key.slice(cut + 1))) continue;
        moved = true;
        return now;
      }
    }
    return key;
  });
  return moved ? [...new Set(next)] : null;
}

interface GrantStore {
  bot(id: string): { alwaysAllow?: string[] } | null | undefined;
  tasks(botId: string): ReadonlyArray<{ threadId: string; alwaysAllow?: string[] }>;
  patchBot(id: string, patch: { alwaysAllow: string[] }): unknown;
  patchTask(botId: string, threadId: string, patch: { alwaysAllow: string[] }): unknown;
}

/** Applies `move` to everything a bot's grants are read from: the bot, each of its threads, and the turn now starting. */
export function moveSavedGrants(store: GrantStore, live: { id: string; alwaysAllow?: string[] }, move: (keys: readonly string[]) => string[] | null): void {
  const saved = store.bot(live.id);
  if (!saved) return;
  const own = move(saved.alwaysAllow ?? []);
  if (own) store.patchBot(live.id, { alwaysAllow: own });
  for (const task of store.tasks(live.id)) {
    const next = move(task.alwaysAllow ?? []);
    if (next) store.patchTask(live.id, task.threadId, { alwaysAllow: next });
  }
  const turn = live === saved ? null : move(live.alwaysAllow ?? []);
  if (turn) live.alwaysAllow = turn;
}
