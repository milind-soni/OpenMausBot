// Where bots are boxed (a Cloud), a bot's turn sees only its own folders, so a command MCP server whose program or files
// are in one bot's folder is that bot's own: no other bot can reach those files, and it starts only for that bot. Files in
// one of a bot's conversation folders (task-workspaces/<bot>/<thread>) go when that conversation does, boxed or not, so a
// server the bot adds from there is copied into the bot's own folder first, under tools/.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { StdioMcpSpec } from "./contracts.ts";
import { addDisabledMcpServer, isRemoteMcpServer, parseStoredMcpServer, type DisabledMcpServerAdd, type StoredStdioMcpServer } from "./mcp-registry.ts";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** What one server's files copied out of a conversation folder may add up to. */
export const MAX_KEPT_BYTES = 512 * 1024 ** 2;
const MAX_KEPT_FILES = 50_000;

export interface BotFolderUse {
  botId: string;
  /** Entries of the bot's conversation folders the server uses (`task-workspaces/<bot>/<thread>/<entry>`, or the whole
   * conversation folder when it names that). */
  temporary: string[];
}

/** One value of a command, argument or environment variable, as the paths it may hold. */
function pathsIn(value: string): string[] {
  const text = value.startsWith("--") && value.includes("=") ? value.slice(value.indexOf("=") + 1) : value;
  return text.split(delimiter).filter((part) => isAbsolute(part));
}

function values(server: StdioMcpSpec): string[] {
  return [server.command, ...server.args, ...Object.values(server.env)].flatMap(pathsIn);
}

function segments(path: string, root: string): string[] | null {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/** The bot whose folders this server's paths are in, "several" when they are in more than one bot's, else null. */
export function botFolderUse(server: StdioMcpSpec, dataDir: string): BotFolderUse | "several" | null {
  const workspaces = join(dataDir, "workspaces"), tasks = join(dataDir, "task-workspaces");
  let botId: string | null = null;
  const temporary: string[] = [];
  for (const value of values(server)) {
    const full = resolve(value);
    const own = segments(full, workspaces), task = segments(full, tasks);
    const owner = own?.[0] ?? task?.[0];
    if (!owner || !ID.test(owner)) continue;
    if (botId && botId !== owner) return "several";
    botId = owner;
    if (task && task.length >= 2 && ID.test(task[1]!)) {
      const entry = join(tasks, owner, task[1]!, ...(task.length >= 3 ? [task[2]!] : []));
      if (!temporary.includes(entry)) temporary.push(entry);
    }
  }
  return botId ? { botId, temporary } : null;
}

/** Bytes and files under `path`, never following a link; null once past the limits. */
function size(path: string, total = { bytes: 0, files: 0 }): { bytes: number; files: number } | null {
  const stat = lstatSync(path);
  total.bytes += stat.size;
  total.files += 1;
  if (total.bytes > MAX_KEPT_BYTES || total.files > MAX_KEPT_FILES) return null;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) if (!size(join(path, name), total)) return null;
  }
  return total;
}

function rebase(value: string, from: string, to: string): string {
  const rebasePath = (path: string) => (path === from ? to : path.startsWith(from + sep) ? to + path.slice(from.length) : path);
  if (value.startsWith("--") && value.includes("=")) {
    const at = value.indexOf("=") + 1;
    return value.slice(0, at) + value.slice(at).split(delimiter).map(rebasePath).join(delimiter);
  }
  return value.split(delimiter).map(rebasePath).join(delimiter);
}

export type KeptServer =
  | { ok: true; server: StoredStdioMcpServer; moved: Array<{ from: string; to: string }> }
  | { ok: false; error: string };

/** Copies the server's files out of the bot's conversation folders into `workspaces/<bot>/tools/` and points the
 * server there. */
export function keepInBotFolder(server: StoredStdioMcpServer, use: BotFolderUse, dataDir: string): KeptServer {
  if (!use.temporary.length) return { ok: true, server, moved: [] };
  const own = join(dataDir, "workspaces", use.botId), tools = join(own, "tools");
  try {
    mkdirSync(tools, { recursive: true, mode: 0o700 });
    // Security: a bot may have made tools/ a link to somewhere else; files are only ever written inside its own folder.
    if (!lstatSync(tools).isDirectory() || segments(realpathSync(tools), realpathSync(own))?.length !== 1) {
      return { ok: false, error: "Its tools folder is not a plain folder inside this bot's own folder." };
    }
  } catch {
    return { ok: false, error: "This bot's own folder could not be prepared." };
  }
  const moved: Array<{ from: string; to: string }> = [];
  for (const from of use.temporary) {
    if (!existsSync(from)) return { ok: false, error: "Its files were in a conversation's temporary folder, and that folder is gone." };
    if (!size(from)) return { ok: false, error: `Its folder is too big to keep: over ${MAX_KEPT_BYTES / 1024 ** 2} MB or ${MAX_KEPT_FILES.toLocaleString("en-US")} files.` };
    const name = basename(from);
    let to = join(tools, name);
    for (let n = 2; existsSync(to); n += 1) {
      if (n > 99) return { ok: false, error: "Its tools folder already has too many copies of this name." };
      to = join(tools, `${name}-${n}`);
    }
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    moved.push({ from, to });
  }
  const rebaseAll = (value: string) => moved.reduce((current, { from, to }) => rebase(current, from, to), value);
  return {
    ok: true,
    moved,
    server: {
      ...server,
      command: rebaseAll(server.command),
      args: server.args.map(rebaseAll),
      env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, rebaseAll(value)])),
    },
  };
}

export type BotMcpServerAdd = DisabledMcpServerAdd & { moved?: Array<{ from: string; to: string }> };

/** A bot's add_mcp_server: saved off as always, with files from one of its conversation folders kept in its own folder.
 * `boxed`: no bot reaches another's folders, so a server using this bot's files becomes its own, and one using another
 * bot's files is refused; unboxed, every bot reaches them and the server stays every bot's. */
export function addBotMcpServer(current: Record<string, unknown>, body: unknown, botId: string, dataDir: string, boxed: boolean): BotMcpServerAdd {
  const added = addDisabledMcpServer(current, body);
  if (!added.ok || isRemoteMcpServer(added.server)) return added;
  const use = botFolderUse(added.server, dataDir);
  if (!use) return added;
  const theirs = use === "several" || use.botId !== botId;
  if (theirs && boxed) {
    return { ok: false, status: 400, error: "That command uses files in another bot's folder, which only that bot can reach. Use files in your own folder." };
  }
  if (theirs) return added;
  const kept = keepInBotFolder(added.server, use, dataDir);
  if (!kept.ok) return { ok: false, status: 400, error: `This server could not be kept: ${kept.error}` };
  const server = boxed ? { ...kept.server, bot: botId } : kept.server;
  return { ...added, server, next: { ...current, [added.name]: server }, moved: kept.moved };
}

export interface ClaimedMcpServers {
  next: Record<string, unknown>;
  /** By bot: the servers that became its own. */
  claimed: Record<string, string[]>;
}

/** Existing installs where bots are boxed: every server no bot owns yet whose files are in the folders of one bot that
 * exists becomes that bot's own, its conversation-folder files kept in its own folder. Null when nothing changes. */
export function claimBotMcpServers(raw: Record<string, unknown> | undefined, dataDir: string, isBot: (botId: string) => boolean): ClaimedMcpServers | null {
  const next: Record<string, unknown> = { ...raw };
  const claimed: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const parsed = parseStoredMcpServer(name, value);
    if (!parsed.ok || isRemoteMcpServer(parsed.server) || parsed.server.bot || parsed.server.runsOn) continue;
    const use = botFolderUse(parsed.server, dataDir);
    if (!use || use === "several" || !isBot(use.botId)) continue;
    let kept: KeptServer;
    try { kept = keepInBotFolder(parsed.server, use, dataDir); } catch (error) { kept = { ok: false, error: String(error) }; }
    if (!kept.ok) console.warn(`[mcp] ${name}: kept in place for its bot: ${kept.error}`);
    next[name] = { ...(kept.ok ? kept.server : parsed.server), bot: use.botId };
    (claimed[use.botId] ??= []).push(name);
  }
  return Object.keys(claimed).length ? { next, claimed } : null;
}

/** Without the servers that were this deleted bot's own; null when it had none. */
export function withoutBotMcpServers(raw: Record<string, unknown> | undefined, botId: string): Record<string, unknown> | null {
  const kept = Object.entries(raw ?? {}).filter(([name, value]) => {
    const parsed = parseStoredMcpServer(name, value);
    return !(parsed.ok && !isRemoteMcpServer(parsed.server) && parsed.server.bot === botId);
  });
  return kept.length === Object.keys(raw ?? {}).length ? null : Object.fromEntries(kept);
}
