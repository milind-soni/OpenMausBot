// Deleting a conversation or a bot removes what it kept on disk outside its transcript: the files uploaded to the
// conversation, its box uploads folder, the session files the engines wrote for it, and for a bot its checkpoints and
// the memory layers kept beside its own folder. A conversation's own folder (task-workspaces/<bot>/<thread>) holds
// files the bot made for the person, and stays when the conversation or the bot is deleted.
//
// Security: a file goes only when it is provably the deleted conversation's or bot's. An upload another conversation,
// a picture or a routine still names stays; an engine session a remaining conversation still resumes stays. Nothing is
// reached through a link: every folder between a root and what is removed must be a real folder, and a link found
// there is removed as a link, never what it points at. Nothing here throws into the delete, which has already happened.
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { baseBotId, isLayerId } from "../audience.ts";

/** A file in attachments/, by its URL or by its path (as JSON escapes it) a sent document's tag carries. */
const ATTACHMENT = /attachments(?:\/|\\)+([A-Za-z0-9][\w.-]{0,200})/g;
const ID = /^[\w-]{1,128}$/;
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WHOLE_SESSION_ID = new RegExp(`^${SESSION_ID.source}$`, "i");
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_NOTED = 5_000;
const MAX_DEPTH = 6;

/** Folder names as Claude Code 2.1 keeps a session's files: `projects/<folder>/<session>.jsonl` and its session
 * folder, and one entry named after the session in each of the others. */
const CLAUDE_SESSION_FOLDERS = ["file-history", "session-env", "todos", "debug"] as const;
/** Codex 0.16 keeps a session as `sessions/<year>/<month>/<day>/rollout-<time>-<session>.jsonl`. */
const CODEX_SESSION_FOLDERS = ["sessions", "archived_sessions"] as const;

export interface EngineSessionFolders {
  claude: readonly string[];
  codex: readonly string[];
  /** Pi names a session by its file's path, so its folders only say where such a file may be. */
  pi: readonly string[];
}

type Cursors = Record<string, unknown> | undefined;
type Change = { type: string; threadId?: string; botId?: string };

export interface DeleteLeftoversDeps {
  dataDir: string;
  store: {
    readonly bots: ReadonlyArray<{ id: string; threadId?: string; resumeCursors?: Cursors; tasks?: ReadonlyArray<{ threadId: string; resumeCursors?: Cursors }> }>;
    messagesFor(threadId: string): readonly unknown[];
    onChange(listener: (change: Change) => void): unknown;
    /** Set here: the store calls it before it tries to delete these conversations. */
    threadsGoing: (threadIds: readonly string[]) => void;
  };
  /** Conversations whose messages still name this text (message-db.ts threadsReferencing). */
  threadsReferencing(fragment: string): readonly string[];
  /** Stored names something other than a transcript uses (pictures, routines' files, files on their way into a turn);
   * null while that cannot be read, and then no upload is removed. */
  keptAttachments(): ReadonlySet<string> | null;
  deleteAttachment(name: string): void;
  engineFolders(): EngineSessionFolders;
  layers: MemoryLayerRecords;
  /** Runs `flush` once the delete under way has finished, so one pass covers every conversation it removed. */
  defer?(flush: () => void): void;
  warn?(line: string): void;
}

export interface MemoryLayerRecords {
  journalFile(layer: string): string;
  /** The layer's indexed notes and its journal's state in memory. */
  forget(layer: string): void;
}

function entries(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function realFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Whether `path` is inside `root` with every folder between them a real folder. */
export function plainlyUnder(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  let at = resolve(root);
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    if (!realFolder(at)) return false;
  }
  return true;
}

/** Removes `path` when it is plainly under `root`; true when something was there and went. */
export function removeUnder(root: string, path: string): boolean {
  if (!exists(path) || !plainlyUnder(root, path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

const sessionIdIn = (name: string) => SESSION_ID.exec(name)?.[0]?.toLowerCase();

function removeClaudeSessions(root: string, sessions: ReadonlySet<string>): number {
  let removed = 0;
  const sweep = (dir: string) => {
    if (!realFolder(dir)) return;
    for (const name of entries(dir)) {
      const id = sessionIdIn(name);
      if (id && sessions.has(id) && removeUnder(root, join(dir, name))) removed++;
    }
  };
  const projects = join(root, "projects");
  if (realFolder(projects)) for (const folder of entries(projects)) sweep(join(projects, folder));
  for (const folder of CLAUDE_SESSION_FOLDERS) sweep(join(root, folder));
  return removed;
}

function removeCodexSessions(root: string, sessions: ReadonlySet<string>): number {
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || !realFolder(dir)) return;
    for (const name of entries(dir)) {
      const path = join(dir, name);
      if (realFolder(path)) { walk(path, depth + 1); continue; }
      const id = sessionIdIn(name);
      if (id && sessions.has(id) && removeUnder(root, path)) removed++;
    }
  };
  for (const folder of CODEX_SESSION_FOLDERS) walk(join(root, folder), 0);
  return removed;
}

function removePiSession(roots: readonly string[], file: string): number {
  if (!file.endsWith(".jsonl")) return 0;
  try { if (!lstatSync(file).isFile()) return 0; } catch { return 0; }
  return roots.some((root) => removeUnder(root, file)) ? 1 : 0;
}

/** The session ids a conversation's event log says its engines started. */
function loggedSessions(dataDir: string, threadId: string): string[] {
  const file = join(dataDir, "events", `${threadId}.ndjson`);
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size > MAX_LOG_BYTES) return [];
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"session.started"')) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; threadId?: unknown; sessionId?: unknown };
      if (event.type === "session.started" && event.threadId === threadId && typeof event.sessionId === "string" && event.sessionId) found.push(event.sessionId);
    } catch { /* a line cut short by a crash names nothing */ }
  }
  return found;
}

const cursorsOf = (cursors: Cursors): string[] => Object.values(cursors ?? {}).filter((cursor): cursor is string => typeof cursor === "string" && cursor !== "");

/** Removes one memory layer of a bot: its folder beside the bot's own, its journal and its indexed notes. */
export function removeMemoryLayer(dataDir: string, layer: string, records: MemoryLayerRecords): void {
  if (!isLayerId(layer)) return;
  removeUnder(dataDir, join(dataDir, "workspaces", layer));
  const journal = records.journalFile(layer);
  removeUnder(dirname(dirname(journal)), journal);
  records.forget(layer);
}

/** Where each engine keeps its sessions, for every environment an engine of this server runs with. */
export function engineSessionFolders(dataDir: string, environments: Iterable<Record<string, string | undefined>>): EngineSessionFolders {
  const claude = new Set<string>(), codex = new Set<string>(), pi = new Set<string>();
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? resolve(value) : null);
  for (const env of environments) {
    const home = absolute(env.HOME) ?? absolute(env.USERPROFILE);
    const claudeFolder = absolute(env.CLAUDE_CONFIG_DIR) ?? (home && join(home, ".claude"));
    const codexFolder = absolute(env.CODEX_HOME) ?? (home && join(home, ".codex"));
    if (claudeFolder) claude.add(claudeFolder);
    if (codexFolder) codex.add(codexFolder);
    if (home) pi.add(join(home, ".pi", "agent"));
  }
  // MausBot's own Codex homes (codex-shared-home.ts): a ChatGPT plan's, and those of turns on the person's own sign-in.
  for (const kind of ["chatgpt-plan", "codex-own"]) {
    const homes = join(resolve(dataDir), "providers", kind);
    for (const home of entries(homes)) codex.add(join(homes, home, "codex"));
  }
  return { claude: [...claude], codex: [...codex], pi: [...pi] };
}

/** An instance's environment as its engine is started with it: the server's, the instance's own over it, and a Claude
 * account's folder (`config.configDir`, absolute or under `~/`) as CLAUDE_CONFIG_DIR. */
export function instanceEnvironment(base: Record<string, string | undefined>, instance: { environment?: Record<string, string>; config?: unknown }): Record<string, string | undefined> {
  const env = { ...base, ...instance.environment };
  const configDir = (instance.config as { configDir?: unknown } | null | undefined)?.configDir;
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof configDir !== "string" || !configDir.trim()) return env;
  const named = configDir.trim();
  const folder = named === "~" ? home : named.startsWith("~/") && home ? join(home, named.slice(2)) : named;
  return folder && isAbsolute(folder) ? { ...env, CLAUDE_CONFIG_DIR: folder } : env;
}

interface Noted {
  attachments: Set<string>;
  sessions: Set<string>;
}

export function createDeleteLeftovers(deps: DeleteLeftoversDeps) {
  const dataDir = resolve(deps.dataDir);
  const attachments = join(dataDir, "attachments");
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const defer = deps.defer ?? ((flush: () => void) => queueMicrotask(flush));
  const noted = new Map<string, Noted>();
  const gone = new Map<string, Noted>();
  const goneBots = new Set<string>();
  let scheduled = false;

  const attempt = (what: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      warn(`delete leftovers: ${what} stayed behind: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function note(threadId: string): void {
    if (!ID.test(threadId)) return;
    const found: Noted = { attachments: new Set(), sessions: new Set() };
    for (const match of JSON.stringify(deps.store.messagesFor(threadId)).matchAll(ATTACHMENT)) found.attachments.add(match[1]!);
    for (const bot of deps.store.bots) {
      if (bot.threadId === threadId) for (const cursor of cursorsOf(bot.resumeCursors)) found.sessions.add(cursor);
      for (const task of bot.tasks ?? []) if (task.threadId === threadId) for (const cursor of cursorsOf(task.resumeCursors)) found.sessions.add(cursor);
    }
    for (const session of loggedSessions(dataDir, threadId)) found.sessions.add(session);
    noted.delete(threadId);
    noted.set(threadId, found);
    if (noted.size > MAX_NOTED) noted.delete(noted.keys().next().value!);
  }

  /** On a Team Cloud each member's picture is named in their own people/<person>/profile.json. */
  function memberPictures(): string {
    const people = join(dataDir, "people");
    return entries(people).map((person) => {
      try { return readFileSync(join(people, person, "profile.json"), "utf8"); } catch { return ""; }
    }).join("\n");
  }

  function removeAttachments(names: ReadonlySet<string>): void {
    if (!names.size) return;
    const kept = deps.keptAttachments();
    if (!kept) return warn("delete leftovers: uploads stayed behind: what still uses them cannot be read right now");
    const pictures = memberPictures();
    for (const name of names) {
      const path = join(attachments, name);
      if (name.includes("..") || basename(name) !== name || kept.has(name) || pictures.includes(name) || !plainlyUnder(dataDir, path)) continue;
      attempt(`the upload ${name}`, () => {
        if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || deps.threadsReferencing(name).length) return;
        deps.deleteAttachment(name);
      });
    }
  }

  function removeSessions(sessions: ReadonlySet<string>): void {
    if (!sessions.size) return;
    const resumed = new Set(deps.store.bots.flatMap((bot) => [...cursorsOf(bot.resumeCursors), ...(bot.tasks ?? []).flatMap((task) => cursorsOf(task.resumeCursors))]));
    const ended = [...sessions].filter((session) => !resumed.has(session));
    const ids = new Set(ended.filter((session) => WHOLE_SESSION_ID.test(session)).map((session) => session.toLowerCase()));
    const files = ended.filter((session) => isAbsolute(session));
    if (!ids.size && !files.length) return;
    const folders = deps.engineFolders();
    const reached = (roots: readonly string[]) => roots.filter((root) => !relative(dataDir, resolve(root)).startsWith("..") ? plainlyUnder(dataDir, root) && realFolder(root) : true);
    if (ids.size) {
      for (const root of reached(folders.claude)) attempt(`engine sessions in ${root}`, () => void removeClaudeSessions(root, ids));
      for (const root of reached(folders.codex)) attempt(`engine sessions in ${root}`, () => void removeCodexSessions(root, ids));
    }
    for (const file of files) attempt(`the engine session ${file}`, () => void removePiSession(reached(folders.pi), file));
  }

  function removeBoxUploads(threadId: string): void {
    const root = join(dataDir, "box-uploads");
    for (const bot of entries(root)) removeUnder(dataDir, join(root, bot, threadId));
  }

  function removeBot(botId: string): void {
    if (!ID.test(botId) || isLayerId(botId)) return;
    attempt(`checkpoints of ${botId}`, () => void removeUnder(dataDir, join(dataDir, "checkpoints", botId)));
    attempt(`box uploads of ${botId}`, () => void removeUnder(dataDir, join(dataDir, "box-uploads", botId)));
    const live = new Set(deps.store.bots.map((bot) => bot.id));
    for (const layer of entries(join(dataDir, "workspaces"))) {
      if (!isLayerId(layer) || baseBotId(layer) !== botId || live.has(layer)) continue;
      attempt(`the memory layer ${layer}`, () => removeMemoryLayer(dataDir, layer, deps.layers));
    }
  }

  function flush(): void {
    scheduled = false;
    const threads = new Map(gone);
    const bots = [...goneBots];
    gone.clear();
    goneBots.clear();
    attempt("uploads", () => removeAttachments(new Set([...threads.values()].flatMap((found) => [...found.attachments]))));
    attempt("engine sessions", () => removeSessions(new Set([...threads.values()].flatMap((found) => [...found.sessions]))));
    for (const threadId of threads.keys()) attempt(`box uploads of ${threadId}`, () => removeBoxUploads(threadId));
    for (const botId of bots) removeBot(botId);
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    defer(() => attempt("leftovers", flush));
  }

  deps.store.threadsGoing = (threadIds) => {
    for (const threadId of new Set(threadIds)) attempt(`leftovers of ${threadId}`, () => note(threadId));
  };
  deps.store.onChange((change) => {
    if (change.type === "thread.deleted" && change.threadId && ID.test(change.threadId)) {
      gone.set(change.threadId, noted.get(change.threadId) ?? { attachments: new Set(), sessions: new Set() });
      noted.delete(change.threadId);
      schedule();
    } else if (change.type === "bot.deleted" && change.botId) {
      goneBots.add(change.botId);
      schedule();
    }
  });

  return { flush };
}
