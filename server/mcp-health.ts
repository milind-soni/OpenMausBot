// Whether each command MCP server starts, started the way a bot's AI would start it. One that does not start is left
// out of turns (an engine that mounts it anyway fails it on every session, and Claude Code then repeats the failure
// under every tool search), the person hears about it once, and it is tried again on its own. A bot's own server is
// checked for that bot; any other server starts the same for every bot on this computer, so one check stands for all.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { McpServerSpec, StdioMcpSpec } from "./contracts.ts";

/** A server that did not start is tried again after this long; one that started is trusted this long. */
export const RECHECK_FAILED_MS = 30 * 60_000;
export const RECHECK_STARTED_MS = 6 * 60 * 60_000;
const CHECKS_AT_ONCE = 2;
/** The check of a server that is no bot's own. */
const EVERY_BOT = "*";

export interface McpStartCheck { ok: boolean; at: number; error?: string }
interface ServerHealth { key: string; checks: Record<string, McpStartCheck>; told?: string }
type Bot = { id: string; name: string };
type CommandServer = StdioMcpSpec & { bot?: string };

export interface McpHealthDeps {
  file: string;
  /** The enabled command servers, by name. */
  servers(): Record<string, CommandServer>;
  /** The bots whose turns start `name`. */
  users(name: string): Bot[];
  /** Starts the server as `botId`'s AI would and lists its tools. */
  start(name: string, server: StdioMcpSpec, botId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Says it to the person, once. */
  tell(text: string, about: Bot): void;
  now?(): number;
}

/** The server's identity for its checks: what runs, and the files its command line names, so a fix shows. */
export function startKey(server: StdioMcpSpec): string {
  const files = [server.command, ...server.args].filter((value) => isAbsolute(value)).map((path) => {
    try { const stat = statSync(path); return [path, stat.size, stat.mtimeMs]; } catch { return [path, null]; }
  });
  return createHash("sha256").update(JSON.stringify([server.command, server.args, Object.entries(server.env).sort(), files])).digest("hex").slice(0, 32);
}

/** A server's name as a tool's name in a sentence: "blender" is "Blender". */
export const toolLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
export const nameList = (names: readonly string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The one plain line about a server that does not start. */
export function offNotice(name: string, owner: Bot | null): string {
  return `${owner ? `${owner.name}'s ${toolLabel(name)} tool` : `The ${toolLabel(name)} tool`} doesn't start, so it's off for now. It comes back on its own once it starts.`;
}

export function createMcpHealth(deps: McpHealthDeps) {
  const now = deps.now ?? Date.now;
  let state: Record<string, ServerHealth> = {};
  try { state = JSON.parse(readFileSync(deps.file, "utf8")) as Record<string, ServerHealth>; } catch {}
  const save = () => { try { writeFileAtomic(deps.file, JSON.stringify(state), { mode: 0o600 }); } catch (error) { console.warn("[mcp] could not save server checks:", error); } };
  const running = new Map<string, Promise<void>>();
  const waiting: Array<() => void> = [];
  let active = 0;
  const slot = async <T,>(work: () => Promise<T>): Promise<T> => {
    if (active >= CHECKS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try { return await work(); } finally { active -= 1; waiting.shift()?.(); }
  };

  const standsFor = (server: CommandServer, botId: string) => (server.bot ? botId : EVERY_BOT);
  const checkOf = (name: string, server: CommandServer, botId: string): McpStartCheck | undefined => {
    const health = state[name];
    return health && health.key === startKey(server) ? health.checks?.[standsFor(server, botId)] : undefined;
  };
  const due = (check: McpStartCheck | undefined) => !check || now() - check.at >= (check.ok ? RECHECK_STARTED_MS : RECHECK_FAILED_MS);

  const record = (name: string, server: CommandServer, botId: string, result: { ok: true } | { ok: false; error: string }) => {
    const key = startKey(server);
    const health = state[name]?.key === key && state[name]!.checks ? state[name]! : (state[name] = { key, checks: {} });
    health.checks[standsFor(server, botId)] = result.ok ? { ok: true, at: now() } : { ok: false, at: now(), error: result.error };
    const tell = !result.ok && health.told !== key;
    if (tell) health.told = key;
    save();
    if (!tell) return;
    const about = deps.users(name).find((bot) => bot.id === botId) ?? deps.users(name)[0];
    if (about) deps.tell(offNotice(name, server.bot ? about : null), about);
  };

  const check = (name: string, server: CommandServer, botId: string): Promise<void> => {
    const id = `${name}\u0000${standsFor(server, botId)}`;
    const pending = running.get(id);
    if (pending) return pending;
    const work = slot(() => deps.start(name, server, botId))
      .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
      .then((result) => record(name, server, botId, result))
      .finally(() => running.delete(id));
    running.set(id, work);
    return work;
  };

  const checkUsers = (name: string, force: boolean) => {
    const server = deps.servers()[name];
    if (!server) return;
    for (const bot of deps.users(name)) {
      if (force || due(checkOf(name, server, bot.id))) void check(name, server, bot.id);
      if (!server.bot) return;
    }
  };

  return {
    /** Before a turn: waits for the first check of each of the bot's command servers, and starts any check due again in
     * the background, so a turn waits for a server at most once. */
    async prepare(botId: string, names: readonly string[]): Promise<void> {
      const servers = deps.servers(), first: Promise<void>[] = [];
      for (const name of names) {
        const server = servers[name];
        if (!server) continue;
        const last = checkOf(name, server, botId);
        if (!last) first.push(check(name, server, botId));
        else if (due(last)) void check(name, server, botId);
      }
      await Promise.all(first);
    },
    /** `mounted` without the command servers that did not start. */
    usable<T extends McpServerSpec>(botId: string, mounted: Record<string, T>): Record<string, T> {
      const servers = deps.servers();
      return Object.fromEntries(Object.entries(mounted).filter(([name]) => !servers[name] || checkOf(name, servers[name], botId)?.ok !== false));
    },
    /** Which of `names` are left out of this bot's turns, with why. */
    off(botId: string, names: readonly string[]): Array<{ name: string; error: string }> {
      const servers = deps.servers();
      return names.flatMap((name) => {
        const last = servers[name] ? checkOf(name, servers[name], botId) : undefined;
        return last && !last.ok ? [{ name, error: last.error ?? "It did not start." }] : [];
      });
    },
    /** Who a server is off for, by bot id. */
    offFor(name: string): string[] {
      const server = deps.servers()[name];
      return server ? deps.users(name).filter((bot) => checkOf(name, server, bot.id)?.ok === false).map((bot) => bot.id) : [];
    },
    /** The bot's AI reported these did not connect: each is checked again now. */
    engineFailed(botId: string, names: readonly string[]): void {
      const servers = deps.servers();
      for (const name of names) if (servers[name]) void check(name, servers[name], botId);
    },
    /** A server was added, changed or turned on: checked again now. */
    changed(name: string): void {
      delete state[name];
      save();
      checkUsers(name, true);
    },
    /** In the background, every enabled command server not checked yet. */
    checkAll(): void {
      for (const name of Object.keys(deps.servers())) checkUsers(name, false);
    },
    /** Settles once every check started so far has. */
    async settled(): Promise<void> {
      while (running.size) await Promise.all(running.values());
    },
  };
}

export type McpHealth = ReturnType<typeof createMcpHealth>;
