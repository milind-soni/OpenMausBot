// Reads a bot's project folder into its checkpoint shadow before the first turn there, so that turn's own snapshot finds the
// files already read: when the folder is set, and once after start-up for the folders in recent use. Only a folder a bot is
// set to work in, only one that holds a repository, and one folder at a time.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SeedTask {
  threadId: string;
  cwd?: string | null;
  updatedAt?: number;
  askedAt?: number;
}

export interface SeedBot {
  id: string;
  cwd?: string;
  tasks?: readonly SeedTask[];
}

export type SeedChange = { type: "bot"; botId: string; threadId?: string } | { type: "bot.deleted"; botId: string } | { type: string };

export interface CheckpointSeedsDeps<Bot extends SeedBot = SeedBot> {
  bots(): readonly Bot[];
  bot(id: string): Bot | null | undefined;
  /** Does the bot's engine work in a folder at all? */
  worksInFolders(bot: Bot): boolean;
  /** Why a folder is never snapshotted, or null. */
  refusal(cwd: string): string | null;
  /** Reads the folder into the bot's shadow without taking a snapshot. */
  prime(botId: string, cwd: string, signal: AbortSignal): Promise<unknown>;
  onChange(listener: (change: SeedChange) => void): unknown;
  /** The app's own folders: a bot's private task folders and the shadows themselves live under these. */
  ownRoots: readonly string[];
  now?(): number;
  /** Runs the start-up pass once the start-up itself is over. */
  later?(run: () => void): void;
}

/** Start-up reads at most this many folders, the most recently used first. */
export const STARTUP_FOLDERS = 6;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 20_000;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createCheckpointSeeds<Bot extends SeedBot>(deps: CheckpointSeedsDeps<Bot>) {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((run) => { setTimeout(run, STARTUP_DELAY_MS).unref?.(); });
  /** Bot and folder, once queued. */
  const queued = new Set<string>();
  /** The folder each bot, and each conversation with one of its own, was last seen set to: a change to anything else about a
   * bot reads nothing. */
  const folders = new Map<string, string | null | undefined>();
  for (const bot of deps.bots()) {
    folders.set(bot.id, bot.cwd);
    for (const task of bot.tasks ?? []) folders.set(`${bot.id}\0${task.threadId}`, task.cwd);
  }
  const moved = (id: string, folder: string | null | undefined): boolean => {
    const before = folders.get(id);
    folders.set(id, folder);
    return Boolean(folder) && before !== folder;
  };
  const queue: Array<{ botId: string; folder: string }> = [];
  let running: { botId: string; folder: string; stop: AbortController } | null = null;
  let stopped = false;
  const idle: Array<() => void> = [];
  const key = (botId: string, folder: string) => `${botId}\0${folder}`;

  const qualifies = (folder: string): boolean => {
    if (!isAbsolute(folder) || deps.refusal(folder) !== null) return false;
    try {
      const real = realpathSync(resolve(folder));
      if (deps.ownRoots.some((root) => inside(resolve(root), resolve(folder)) || inside(realpathSync(resolve(root)), real))) return false;
      return existsSync(join(real, ".git"));
    } catch {
      return false;
    }
  };

  const pump = (): void => {
    if (running || stopped) return;
    const next = queue.shift();
    if (!next) {
      for (const done of idle.splice(0)) done();
      return;
    }
    const mine = { ...next, stop: new AbortController() };
    running = mine;
    void deps.prime(next.botId, next.folder, mine.stop.signal).catch(() => {}).then(() => {
      // Cut short: the folder may be read again when the bot is next set to it.
      if (mine.stop.signal.aborted) queued.delete(key(next.botId, next.folder));
      if (running === mine) running = null;
      pump();
    });
  };

  const consider = (bot: Bot, folder: string | null | undefined): void => {
    if (stopped || !folder || queued.has(key(bot.id, folder)) || !deps.worksInFolders(bot) || !qualifies(folder)) return;
    queued.add(key(bot.id, folder));
    queue.push({ botId: bot.id, folder });
    pump();
  };

  /** Is the bot, or one of its conversations, still set to this folder? */
  const worksIn = (bot: Bot, folder: string): boolean => bot.cwd === folder || (bot.tasks ?? []).some((task) => task.cwd === folder);

  const forget = (botId: string, keep: (folder: string) => boolean = () => false): void => {
    for (let at = queue.length - 1; at >= 0; at -= 1) {
      const one = queue[at]!;
      if (one.botId !== botId || keep(one.folder)) continue;
      queue.splice(at, 1);
      queued.delete(key(botId, one.folder));
    }
    if (running?.botId === botId && !keep(running.folder)) running.stop.abort();
  };

  deps.onChange((change) => {
    if (change.type !== "bot" && change.type !== "bot.deleted") return;
    if (!("botId" in change)) return;
    const bot = change.type === "bot" ? deps.bot(change.botId) : undefined;
    if (!bot) {
      for (const id of folders.keys()) if (id === change.botId || id.startsWith(`${change.botId}\0`)) folders.delete(id);
      return forget(change.botId);
    }
    forget(bot.id, (folder) => worksIn(bot, folder));
    if (moved(bot.id, bot.cwd)) consider(bot, bot.cwd);
    const task = "threadId" in change && change.threadId ? bot.tasks?.find((one) => one.threadId === change.threadId) : undefined;
    // A conversation pinned to its bot's own folder is pinned as its turn starts: that turn reads the folder itself.
    if (task && moved(`${bot.id}\0${task.threadId}`, task.cwd) && task.cwd !== bot.cwd) consider(bot, task.cwd);
  });

  return {
    /** The folders of the conversations used in the last week, most recent first. */
    start(): void {
      later(() => {
        const used = new Map<string, { bot: Bot; folder: string; at: number }>();
        for (const bot of deps.bots()) {
          for (const task of bot.tasks ?? []) {
            const folder = task.cwd === undefined ? bot.cwd : task.cwd;
            const at = Math.max(task.askedAt ?? 0, task.updatedAt ?? 0);
            if (!folder || now() - at > RECENT_MS) continue;
            const known = used.get(key(bot.id, folder));
            if (!known || known.at < at) used.set(key(bot.id, folder), { bot, folder, at });
          }
        }
        for (const { bot, folder } of [...used.values()].sort((left, right) => right.at - left.at).slice(0, STARTUP_FOLDERS)) consider(bot, folder);
      });
    },
    stop(): void {
      stopped = true;
      queue.length = 0;
      running?.stop.abort();
    },
    /** Resolves once nothing is being read or waiting to be. */
    settled(): Promise<void> {
      return running || queue.length > 0 ? new Promise((done) => { idle.push(done); }) : Promise.resolve();
    },
  };
}
