// routines.json as it is read at start, and again while it cannot be read. A file that is there but unreadable is never
// taken for an empty one: the caller refuses every save while it stays so, a copy is set aside the first time each
// unreadable content is seen, and the read is tried again until it works.
import { readFileSync } from "node:fs";

import type { RoutineHoldCause } from "../shared/routines.ts";
import { attachmentsMalformed } from "./routine-attachments.ts";
import { loadEventReceipts, type EventRunReceipt } from "./routine-event-receipts.ts";
import { holdCauses } from "./routine-holds.ts";
import { loadRequestReceipts, loadRoutine, loadRun } from "./routine-load.ts";
import { loadOwnerNotices, type RoutineOwnerNotice } from "./routine-recovery.ts";
import type { Routine, RoutineRequestReceipt, RoutineRun } from "./routines.ts";

/** While routines.json cannot be read, the read is tried again this often. */
export const UNREADABLE_RETRY_MS = 60_000;
export interface RoutineFileContents {
  text: string;
  routines: Routine[];
  /** Rows whose schedule could not load: written back unchanged. */
  unloadedRoutines: Routine[];
  runs: RoutineRun[];
  malformedAttachments: boolean;
  routineRequestReceipts: RoutineRequestReceipt[];
  webhookRunReceipts: EventRunReceipt[];
  frozenPending: boolean;
  ownerNotices: RoutineOwnerNotice[];
  holds: RoutineHoldCause[];
  startupLaunchId: string | undefined;
  /** The one look for routines an earlier version switched off (routine-no-start.ts) was taken. */
  noStartOffsChecked: boolean;
}

/** `reason` never quotes the file: a JSON error can echo a fragment of it. */
export type RoutineFileRead = { state: "missing" } | { state: "unreadable"; reason: string } | ({ state: "ok" } & RoutineFileContents);

export function readRoutineFile(file: string, now: number): RoutineFileRead {
  try {
    const text = readFileSync(file, "utf8"), disk = JSON.parse(text) as Record<string, unknown> | null;
    if (disk === null || typeof disk !== "object" || Array.isArray(disk)) throw new Error("Invalid routines file");
    for (const key of ["routines", "runs", "routineRequestReceipts", "webhookRunReceipts"]) {
      if (key in disk && !Array.isArray(disk[key])) throw new Error(`Invalid routines file: ${key} is not a list`);
    }
    const saved = (disk.routines ?? []) as Routine[], unloadedRoutines: Routine[] = [];
    const routines = saved.flatMap((routine) => {
      const loaded = loadRoutine(routine, now);
      if (loaded) return [loaded];
      console.warn(`routines: keeping ${String(routine.id)} on disk unscheduled; its schedule could not load`);
      unloadedRoutines.push(routine);
      return [];
    });
    const runs = ((disk.runs ?? []) as RoutineRun[]).map(loadRun);
    return {
      state: "ok", text, routines, unloadedRoutines, runs,
      malformedAttachments: attachmentsMalformed([...saved, ...((disk.runs ?? []) as RoutineRun[])]),
      routineRequestReceipts: loadRequestReceipts(disk.routineRequestReceipts),
      webhookRunReceipts: loadEventReceipts(disk.webhookRunReceipts, runs, now),
      frozenPending: disk.frozenResultsCleared !== true,
      ownerNotices: loadOwnerNotices(disk.ownerNotices),
      holds: holdCauses(disk.holds),
      startupLaunchId: typeof disk.startupLaunchId === "string" ? disk.startupLaunchId : undefined,
      noStartOffsChecked: disk.noStartOffsChecked === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unable to read routines" };
  }
}

export { keepUnreadableAside } from "./unreadable-aside.ts";
