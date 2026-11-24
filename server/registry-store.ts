// Where the Store keeps its bots, rooms and their threads. The Store says what changed (one thread, one owner's record,
// an owner gone, the whole list) and how soon it must be on disk; the registry decides how to write that. Today's one
// layout keeps everything in bots.json and groups.json, each rewritten whole for any change: temp file, fsync, rename,
// owner-only, skipped when the text is unchanged. A layout that keeps threads as rows can write one row where this one
// writes a whole file, behind the same calls.
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { OwnedFile } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { BotsText } from "./bots-text.ts";
import { batchSaves, saveLater, saveSoon, supersedeLaterSave } from "./save-batch.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export const BOTS_FILE = join(DATA_DIR, "bots.json");
export const GROUPS_FILE = join(DATA_DIR, "groups.json");

export type RegistryOwner = { kind: "bot" | "group"; id: string };

/**
 * How soon a change must be on disk:
 * - "now": before the call returns, synced. Creates, deletions, permissions, anything a person asked for; a failure
 *   throws, so the caller can put memory back (server/registry-save.ts commitRegistryChange).
 * - "pass": when the running batch ends (`batch`, server/save-batch.ts batchSaves), at once outside one. A turn's
 *   bookkeeping that must survive a crash: an engine session, which engine has the thread, what was handed to it.
 * - "later": within SAVE_LATER_MAX_MS (server/save-batch.ts saveLater). Only what server/registry-save.ts
 *   DEFERRABLE_FIELDS allows, and a thread's usage: harmless to lose in a crash. Bots only: nothing of a room waits,
 *   and no room save supersedes a waiting write, so the types refuse "later" for a room.
 */
export type RegistryDurability = "now" | "pass" | "later";

export interface RegistryStore {
  /** The saved bots as parsed; throws when nothing readable is saved, which must never read as "every bot was deleted". */
  loadBots(): BotRecord[];
  /** The saved rooms as parsed; throws when nothing readable is saved. */
  loadGroups(): GroupRecord[];
  /** Every bot and its threads as `bots` holds them, synced before it returns. `bots` may be a list that is not live
   * yet (saved first, so a failure leaves memory alone); `current` says it is the live list, holding every change. */
  writeBots(bots: readonly BotRecord[], current: boolean): void;
  /** Every room and its threads as `groups` holds them, synced before it returns. */
  writeGroups(groups: readonly GroupRecord[]): void;
  /**
   * One owner's thread changed (`threadId`), or its record or any of its threads (undefined). `write` is the Store's
   * own save of the whole list (what rollback and tests hook); it runs when `durability` says, and it throws for "now".
   * A row layout narrows that save to the one thread; this one writes the whole file.
   */
  upsertThread(owner: RegistryOwner & { kind: "bot" }, threadId: string | undefined, durability: RegistryDurability, write: () => void): void;
  upsertThread(owner: RegistryOwner & { kind: "group" }, threadId: string | undefined, durability: Exclude<RegistryDurability, "later">, write: () => void): void;
  /** An owner's record or one of its threads changed in place with no save of its own: it goes with the next save. */
  changedInPlace(owner: RegistryOwner): void;
  /** An owner and all its threads leave the registry; `write` saves the list without it, synced, before it returns. */
  deleteOwner(owner: RegistryOwner, write: () => void): void;
  /** Saves asked for with "pass" while `run` runs are written once when it returns: one transaction in a row layout. */
  batch<T>(run: () => T): T;
}

/** Owner-only (0600): the registries hold souls, project paths and per-bot settings. Best effort; Windows has no POSIX mode bits. */
function tightenRegistryFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
  }
}

export function persistedPin<T extends { pinned?: boolean }>(task: T): T {
  if (task.pinned === true) return task;
  if (!("pinned" in task)) return task;
  const { pinned: _pinned, ...rest } = task;
  return rest as T;
}

/** What bots.json holds of one bot: live state (busy, activity, a turn's start) is never saved. */
export const persistedBot = ({ busy: _busy, activity: _activity, ...bot }: BotRecord) => ({ ...bot,
  tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => persistedPin(task)),
});

export const persistedBots = (bots: readonly BotRecord[]) => bots.map(persistedBot);

/** Set to 1, every save of bots.json serializes every bot. */
export const BOTS_FULL_SAVE_ENV = "OMB_BOTS_FULL_SAVE";
/** Set to 1 (fixture servers), a narrowed save that differs from the whole serialization throws. */
export const BOTS_SAVE_CHECK_ENV = "OMB_BOTS_SAVE_CHECK";
/** The waiting whole pass after a narrowed save has its own key: a whole write of the live list supersedes the waiting
 * writes of BOTS_FILE, and is that pass's job too. */
const WHOLE_PASS = `${BOTS_FILE}:whole`;

/** What groups.json holds: a room's running turn is never saved. */
export const persistedGroups = (groups: readonly GroupRecord[]) => groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
  ...g,
  ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
}));

/** Today's layout: bots.json and groups.json, each the whole list with its threads. */
export class JsonRegistry implements RegistryStore {
  private readonly botsFile = new OwnedFile(BOTS_FILE, { mode: 0o600 });
  private readonly groupsFile = new OwnedFile(GROUPS_FILE, { mode: 0o600 });
  private readonly botsText = new BotsText(persistedBot);
  private readonly narrows = process.env[BOTS_FULL_SAVE_ENV] !== "1";
  /** In tests and fixture servers, every narrowed text is compared with the whole serialization, so a path that changes
   * a bot its save does not name fails there instead of waiting for the next whole pass. */
  private readonly checksNarrowing = process.env.VITEST !== undefined || process.env[BOTS_SAVE_CHECK_ENV] === "1";
  private narrowing = false;
  /** A narrowed text was written since the last whole one. */
  private narrowedSinceWhole = false;

  loadBots(): BotRecord[] {
    tightenRegistryFile(BOTS_FILE);
    supersedeLaterSave(BOTS_FILE); // the file is read afresh, so a write still waiting has nothing left to add
    supersedeLaterSave(WHOLE_PASS);
    const text = readFileSync(BOTS_FILE, "utf8"), bots = JSON.parse(text) as BotRecord[];
    this.botsFile.loaded(text);
    return bots;
  }

  loadGroups(): GroupRecord[] {
    tightenRegistryFile(GROUPS_FILE);
    const text = readFileSync(GROUPS_FILE, "utf8"), groups = JSON.parse(text) as GroupRecord[];
    this.groupsFile.loaded(text);
    return groups;
  }

  writeBots(bots: readonly BotRecord[], current: boolean): void {
    const narrow = this.narrowing && current && this.botsText.canNarrow(bots);
    this.narrowing = false; // one narrowed write per request; any other save made during it (by a listener) is whole
    const { text, commit } = this.botsText.build(bots, narrow);
    if (narrow && this.checksNarrowing) assertNarrowed(text, bots);
    try {
      this.botsFile.write(text);
    } catch (error) {
      this.botsText.forget();
      throw error;
    }
    if (current) {
      commit();
      supersedeLaterSave(BOTS_FILE);
      this.narrowedSinceWhole = narrow;
      if (!narrow) supersedeLaterSave(WHOLE_PASS);
    } else this.botsText.forget();
  }

  writeGroups(groups: readonly GroupRecord[]): void {
    this.groupsFile.write(JSON.stringify(persistedGroups(groups)));
  }

  upsertThread(owner: RegistryOwner, _threadId: string | undefined, durability: RegistryDurability, write: () => void): void {
    if (owner.kind === "bot" && this.narrows) {
      this.botsText.name(owner.id); // a waiting "later" write is superseded by the next narrowed one, so it must hold this owner
      // A "later" write is already one per moment however many changes wait; it stays whole, so nothing it queues can
      // miss the flush at exit.
      if (durability !== "later") {
        const whole = write;
        write = () => this.narrowed(whole);
      }
    }
    if (durability === "pass") saveSoon(owner.kind === "bot" ? this.botsFile : this.groupsFile, write);
    else if (durability === "later") saveLater(BOTS_FILE, write); // bots only (see RegistryDurability)
    else write();
  }

  /** Runs the Store's save of the whole list serializing only the bots named since the last write, then queues a whole
   * pass for what was changed in place on a bot no save named. */
  private narrowed(write: () => void): void {
    this.narrowing = true;
    try {
      write();
    } finally {
      this.narrowing = false;
    }
    if (this.narrowedSinceWhole) saveLater(WHOLE_PASS, write);
  }

  changedInPlace(owner: RegistryOwner): void {
    if (owner.kind === "bot") this.botsText.name(owner.id);
  }

  deleteOwner(_owner: RegistryOwner, write: () => void): void {
    write();
  }

  batch<T>(run: () => T): T {
    return batchSaves(run);
  }
}

function assertNarrowed(text: string, bots: readonly BotRecord[]): void {
  if (text === JSON.stringify(persistedBots(bots))) return;
  const stale = bots.filter((bot) => !text.includes(JSON.stringify(persistedBot(bot)))).map((bot) => bot.id);
  throw new Error(`a narrowed save of bots.json left out a change to ${stale.join(", ")}: name its owner, or save it whole`);
}
