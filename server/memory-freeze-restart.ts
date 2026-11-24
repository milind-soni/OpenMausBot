// A turn that browsed when the server froze for want of memory is not started again by the restart that ends the freeze.
// A 2 GB Cloud froze on a bot's first browsing turn (Nov 2026); the Admin's restart reran the turn a restart cut off, the
// turn opened the same page, and the Cloud froze again within two minutes. The evidence is on the volume: the stall
// watch's records (perf/stall-watch.ts) say the main thread was stuck with memory too short even to profile it. Such a
// turn ends with the line a turn stopped for memory ends with, and the person sends again when they choose. A memory
// stop's automatic retry never follows: it hears only a turn that failed while it ran.
import { join } from "node:path";

import { chatNotice } from "./chat-notices.ts";
import { readStallRecords, STALL_FILE } from "./perf/stall-watch.ts";
import type { StallRecord } from "./perf/stall-sample.ts";
import { toolSurfaceKind } from "../shared/tool-surface.ts";

/** Memory available below this, or the memory stall (full avg10, percent) at least this, in a stall record is a freeze for
 * want of memory (relief's critical line on a 2 GB home, and its thrash line). A record that could read neither counts
 * when it gave memory as the reason it took no profile. */
const FREEZE_AVAILABLE_MB = 160, FREEZE_STALL_PERCENT = 40;

function outOfMemory(record: StallRecord): boolean {
  const { availableMB, memoryFull10 } = record.machine;
  if (availableMB === null && memoryFull10 === null) return record.why === "memory";
  return (availableMB ?? Infinity) < FREEZE_AVAILABLE_MB || (memoryFull10 ?? 0) >= FREEZE_STALL_PERCENT;
}

/** Whether the watch recorded a stall with memory run out between `from` (a cut turn's start) and `to` (this start): a
 * freeze that turn ran through, not one before it that the server came back from. */
export function frozeForMemory(records: readonly StallRecord[], from: number, to: number): boolean {
  return records.some((record) => from <= record.at && record.at <= to && outOfMemory(record));
}

type Line = { at?: number; tool?: { name?: string } | null };

/** Whether the conversation shows a browser call from `since` on. */
export function browsedSince(lines: readonly Line[], since: number): boolean {
  return lines.some((line) => (line.at ?? 0) >= since && typeof line.tool?.name === "string" && toolSurfaceKind(line.tool.name) === "browser");
}

/** The line a cut turn ends with in place of running again: that of a turn whose browser was closed for memory. */
export const FROZE_BROWSING = chatNotice("chat.notice.memoryReclaimedBrowser");

/**
 * What a turn a restart cut off ends with instead of starting again, or null to start it again: null unless the turn ran
 * through a freeze for want of memory (one recorded after it started) and browsed, or when its start is unknown. Each
 * caller (the coordinator, the routines) reads the records once, at its first ask.
 */
export function restartCutStop(deps: { dataDir: string; lines(threadId: string): readonly Line[]; startedAt?: number; read?: (file: string) => StallRecord[] }) {
  // This process's own start: a stall this run records later is not one the turn ran through.
  const startedAt = deps.startedAt ?? Date.now() - process.uptime() * 1000;
  let records: StallRecord[] | undefined;
  return (threadId: string, since: number | undefined): string | null => {
    if (since === undefined) return null;
    records ??= (deps.read ?? readStallRecords)(join(deps.dataDir, STALL_FILE));
    return frozeForMemory(records, since, startedAt) && browsedSince(deps.lines(threadId), since) ? FROZE_BROWSING : null;
  };
}
