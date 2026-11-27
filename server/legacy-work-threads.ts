// Before Full access became the default (2026-10-14), a work thread a teammate's hand-off opened ("@Sender · work", reused by
// every later hand-off from that conversation) saved the default of the day, Ask, though nobody picked it. Its bot now reads
// Full access, yet that thread still asked for everything. Once per data folder, on load, such a thread drops the Ask it
// saved and follows its bot's level from then on. A conversation a person opened is never one of these.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { BotRecord, TaskRecord } from "./store.ts";

/** The day Full access became the level a new bot and thread start at. */
export const FULL_ACCESS_DEFAULT_SINCE = Date.UTC(2026, 9, 14);

const MARKER = "legacy-work-threads-follow-bot";

/** A hand-off's standing work thread (not a room job's), made before that day, that still saves Ask. Its creation time comes
 * from the record; the opener's timestamp, written in the same moment, stands in only where that is missing. */
export function legacyAskWorkThread(task: TaskRecord): boolean {
  const opened = task.openedBy;
  if (opened?.kind !== "work" || opened.roomLane || task.botApi || task.approvalMode !== "ask") return false;
  const at = Number.isFinite(task.createdAt) ? task.createdAt : opened.at;
  return Number.isFinite(at) && at < FULL_ACCESS_DEFAULT_SINCE;
}

/** Runs once: null when it ran already, or when bots.json could not be read (`readable` false), so a later load still can.
 * A bot whose level change was pending at shutdown is left alone: the grant's own recovery decides its threads. Call `done`
 * once the repaired bots are saved. */
export function repairLegacyWorkThreads(dataDir: string, bots: readonly BotRecord[], readable: boolean): { changed: boolean; done(): void } | null {
  const marker = join(dataDir, MARKER);
  if (!readable || existsSync(marker)) return null;
  let changed = false;
  for (const task of bots.flatMap((bot) => bot.approvalGrant ? [] : bot.tasks ?? [])) {
    if (!legacyAskWorkThread(task)) continue;
    // All three go: a thread keeping any of them would not follow its bot (threadApproval).
    delete task.approvalMode;
    delete task.autoApprove;
    delete task.alwaysAllow;
    changed = true;
  }
  return { changed, done: () => writeFileAtomic(marker, "Work threads saved at Ask before Full access was the default follow their bot.\n", { mode: 0o600 }) };
}
