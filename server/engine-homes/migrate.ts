// A Team Cloud's first start with engine homes: the transcripts and session files its engines kept in the server's HOME
// move into the home of the conversation they belong to, found by the session id the server keeps for it (or, for
// Claude, by the conversation's own folder). What matches nothing goes to the held folder, where no route and no box
// reaches it, and is deleted after HELD_DAYS.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import type { Audience } from "../audience.ts";
import { HELD_DAYS, HELD_DIR, audienceHome, engineHomesRoot, homedSpawn } from "./layout.ts";

const MARKER = ".migrated";
const DAY_MS = 86_400_000;
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface MigrationThread {
  threadId: string;
  /** The engines' session ids the server resumes this conversation with. */
  cursors: readonly unknown[];
  /** The folder its turns run in, when pinned. */
  cwd?: string | null;
}

export interface MigrationInput {
  dataDir: string;
  serverHome: string;
  /** The server's own environment, whose engine folder variables say where the engines kept their state. */
  env: Record<string, string | undefined>;
  threads: () => Iterable<MigrationThread>;
  audienceOf(threadId: string): Audience;
  now?: number;
}

export interface MigrationResult {
  ran: boolean;
  moved: number;
  held: number;
  swept: number;
}

/** Claude Code names a project's folder by its working folder, every character but a letter or digit made `-` (2.1). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Each engine's session files, by folder variable: `sessions` are matched to a conversation; `private` move to the held
 * folder whole. Names as Claude Code 2.1 and Codex 0.16 keep them. */
const ENGINE_STATE: ReadonlyArray<{ variable: string; home: string; sessions: readonly string[]; private: readonly string[] }> = [
  { variable: "CLAUDE_CONFIG_DIR", home: ".claude", sessions: ["projects", "file-history", "session-env", "todos", "debug"],
    private: ["history.jsonl", "shell-snapshots", "plans", "paste-cache"] },
  { variable: "CODEX_HOME", home: ".codex", sessions: ["sessions", "archived_sessions"], private: ["history.jsonl", "log", "shell_snapshots"] },
];

function moveEntry(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function entries(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Every file under `dir` (a folder that holds sessions in dated subfolders), deepest last. */
function walk(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  const found: string[] = [];
  for (const name of entries(dir)) {
    const path = join(dir, name);
    let stats;
    try { stats = lstatSync(path); } catch { continue; }
    if (stats.isDirectory()) found.push(...walk(path, depth + 1));
    else found.push(path);
  }
  return found;
}

export function sweepHeld(dataDir: string, now = Date.now()): number {
  const held = join(engineHomesRoot(dataDir), HELD_DIR);
  let swept = 0;
  for (const name of entries(held)) {
    const at = Number(name);
    if (!Number.isSafeInteger(at) || now - at < HELD_DAYS * DAY_MS) continue;
    rmSync(join(held, name), { recursive: true, force: true });
    swept++;
  }
  return swept;
}

export function migrateEngineHomes(input: MigrationInput): MigrationResult {
  const now = input.now ?? Date.now();
  const root = engineHomesRoot(input.dataDir);
  const swept = sweepHeld(input.dataDir, now);
  if (existsSync(join(root, MARKER))) return { ran: false, moved: 0, held: 0, swept };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bySession = new Map<string, string>();
  const bySlug = new Map<string, string | null>();
  for (const thread of input.threads()) {
    for (const cursor of thread.cursors) if (typeof cursor === "string" && cursor) bySession.set(cursor.toLowerCase(), thread.threadId);
    if (thread.cwd) {
      const slug = claudeProjectSlug(thread.cwd);
      bySlug.set(slug, bySlug.has(slug) && bySlug.get(slug) !== thread.threadId ? null : thread.threadId);
    }
  }
  const heldRoot = join(root, HELD_DIR, String(now));
  let moved = 0, held = 0;
  const hold = (from: string, serverFolder: string, home: string) => {
    moveEntry(from, join(heldRoot, home, relative(serverFolder, from)));
    held++;
  };
  for (const engine of ENGINE_STATE) {
    const named = input.env[engine.variable];
    const serverFolder = named && isAbsolute(named) ? named : join(input.serverHome, engine.home);
    const folderIn = (audience: Audience) => {
      const home = audienceHome(input.dataDir, audience);
      return homedSpawn(input.env, { dataDir: input.dataDir, serverHome: input.serverHome, home }).env[engine.variable] ?? join(home, engine.home);
    };
    const place = (from: string, threadId: string | undefined) => {
      if (!threadId) return hold(from, serverFolder, engine.home);
      const to = join(folderIn(input.audienceOf(threadId)), relative(serverFolder, from));
      if (existsSync(to)) return hold(from, serverFolder, engine.home);
      moveEntry(from, to);
      moved++;
    };
    for (const sessions of engine.sessions) {
      const dir = join(serverFolder, sessions);
      if (sessions === "projects") {
        for (const slug of entries(dir)) {
          const project = join(dir, slug);
          for (const name of entries(project)) {
            const id = SESSION_ID.exec(name)?.[0]?.toLowerCase();
            place(join(project, name), (id && bySession.get(id)) ?? bySlug.get(slug) ?? undefined);
          }
          if (!entries(project).length) rmSync(project, { recursive: true, force: true });
        }
      } else if (engine.variable === "CODEX_HOME") {
        for (const file of walk(dir)) {
          const id = SESSION_ID.exec(basename(file))?.[0]?.toLowerCase();
          place(file, id ? bySession.get(id) : undefined);
        }
      } else {
        for (const name of entries(dir)) {
          const id = SESSION_ID.exec(name)?.[0]?.toLowerCase();
          place(join(dir, name), id ? bySession.get(id) : undefined);
        }
      }
    }
    for (const name of engine.private) {
      const path = join(serverFolder, name);
      if (existsSync(path)) hold(path, serverFolder, engine.home);
    }
  }
  writeFileSync(join(root, MARKER), `${JSON.stringify({ at: now, moved, held })}\n`, { mode: 0o600 });
  return { ran: true, moved, held, swept };
}

export type StoreBotThreads = ReadonlyArray<{
  threadId?: string;
  resumeCursors?: Record<string, unknown>;
  tasks?: ReadonlyArray<{ threadId: string; resumeCursors?: Record<string, unknown>; cwd?: string | null }>;
}>;

/** The store's conversations with the engine sessions they resume and the folders they run in. */
export function storeThreads(bots: StoreBotThreads): MigrationThread[] {
  const threads: MigrationThread[] = [];
  for (const bot of bots) {
    if (bot.threadId && bot.resumeCursors) threads.push({ threadId: bot.threadId, cursors: Object.values(bot.resumeCursors) });
    for (const task of bot.tasks ?? []) threads.push({ threadId: task.threadId, cursors: Object.values(task.resumeCursors ?? {}), cwd: task.cwd ?? null });
  }
  return threads;
}
