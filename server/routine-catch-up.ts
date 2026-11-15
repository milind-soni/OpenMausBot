// What a routine does about the occurrences that came due while nothing could start them (the app closed, the computer
// asleep, a Cloud home off or restarting): the newest one runs late when it is still within CATCH_UP_MS of its time, and
// the ones before it close as missed on one row that counts them and says why. Late starts found in one scheduler pass
// are spread out, so a long downtime does not start every routine in the same second.
import { randomUUID } from "node:crypto";

import { runsOnce } from "../shared/limit-reset.ts";
import { intervalHasRestrictions } from "./routine-intervals.ts";
import { codedLine, type RoutineLineKey } from "./routine-lines.ts";
import { isOccurrenceRun } from "./routine-occurrences.ts";
import { routineRunDefinition } from "./routine-run-definition.ts";
import { nextOccurrence, type RoutineSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineRun } from "./routines.ts";

/** An occurrence found later than this still runs only if it is the newest; older than this it is missed. */
export const CATCH_UP_MS = 12 * 60 * 60_000;
/** A row made later than this after its time is a late start, for the spreading below. */
export const CATCH_UP_LATE_MS = 2 * 60_000;
/** Late starts made in one pass begin this far apart, over at most this many steps. */
export const CATCH_UP_STAGGER_MS = 15_000;
export const CATCH_UP_STAGGER_STEPS = 40;
/** Occurrences walked one by one before the rest are estimated from their spacing. */
const WALK_LIMIT = 2_000;

type DownWhy = Extract<RoutineLineKey, "routines.server.part.computerOff" | "routines.server.part.cloudDown">;

/** From the occurrence at `first`, the newest one at or before `now`, and how many there are up to it. Past WALK_LIMIT
 * the count is an estimate. */
export function passedOccurrences(schedule: RoutineSchedule, first: number, now: number): { latest: number; count: number } {
  if (runsOnce(schedule) || schedule.type === "limit_reset" || now <= first) return { latest: first, count: 1 };
  if (schedule.type === "interval" && !intervalHasRestrictions(schedule)) {
    const every = schedule.everyMinutes * 60_000, steps = Math.floor((now - first) / every);
    return { latest: first + steps * every, count: steps + 1 };
  }
  let latest = first, count = 1;
  for (; count < WALK_LIMIT; count += 1) {
    const next = nextOccurrence(schedule, latest);
    if (next === null || next > now) return { latest, count };
    latest = next;
  }
  const spacing = Math.max(60_000, (latest - first) / (count - 1));
  for (let back = 4 * spacing; back <= 4_000 * spacing; back *= 10) {
    let at = nextOccurrence(schedule, Math.max(latest, now - back));
    if (at === null || at > now) continue;
    for (let walked = 0; walked < WALK_LIMIT; walked += 1) {
      const next = nextOccurrence(schedule, at);
      if (next === null || next > now) break;
      at = next;
    }
    return { latest: at, count: count + Math.max(1, Math.round((at - latest) / spacing)) };
  }
  return { latest, count };
}

export interface OccurrencePlan {
  /** The scheduled-for time of the row to make. */
  scheduledFor: number;
  /** The oldest occurrence dealt with: the routine's next run as it was. */
  first: number;
  /** The newest occurrence dealt with: the routine's next run is the first after it. */
  through: number;
  /** How many occurrences this deals with. */
  count: number;
  /** What the row is besides a queued run: nothing, or the fields of a missed row. */
  fields: Partial<RoutineRun>;
  /** The row starts late, so its start is spread out with the pass's other late starts. */
  late: boolean;
  /** The occurrences before the one that runs: one more row, already closed, that counts them. */
  older?: { scheduledFor: number; count: number; fields: Partial<RoutineRun> };
}

function missedFields(count: number, firstAt: number, lastAt: number, why: DownWhy, now: number, told: boolean): Partial<RoutineRun> {
  const line = !told || count > 1 ? codedLine("error", count > 1 ? "routines.server.missedMany" : "routines.server.missedOne", count > 1 ? { count, why } : { why })
    : codedLine("error", "routines.server.missedTooLate", { why, hours: CATCH_UP_MS / 3_600_000 });
  const counts = count > 1 || !told;
  return {
    status: "missed", finishedAt: now, error: line.text, ...line.codes, ...(told ? {} : { seenAt: now }),
    ...(counts ? { skipped: { count, firstAt, lastAt, behind: `down:${why.endsWith("cloudDown") ? "cloud" : "computer"}:${now}`, ...(told ? { told: true as const } : {}) } } : {}),
  };
}

/** What to do with the routine's next run, which is due: run it; or, found late, run the newest occurrence passed and
 * close the older ones; or, with the newest too old as well, close them all on one row the owner is told about. A
 * limit reset is a state, not a moment: it still holds however late the computer wakes. */
export function planOccurrence(routine: Pick<Routine, "schedule" | "nextRunAt">, now: number, cloud: boolean): OccurrencePlan {
  const first = routine.nextRunAt!, why: DownWhy = cloud ? "routines.server.part.cloudDown" : "routines.server.part.computerOff";
  const late = now - first > CATCH_UP_LATE_MS;
  const { latest, count } = late ? passedOccurrences(routine.schedule, first, now) : { latest: first, count: 1 };
  if (now - latest > CATCH_UP_MS && routine.schedule.type !== "limit_reset") {
    return { scheduledFor: first, first, through: latest, count, late: false, fields: missedFields(count, first, latest, why, now, true) };
  }
  const before = count > 1 ? lastBefore(routine.schedule, first, latest) : first;
  return {
    scheduledFor: latest, first, through: latest, count, late, fields: {},
    ...(count > 1 ? { older: { scheduledFor: first, count: count - 1, fields: missedFields(count - 1, first, before, why, now, false) } } : {}),
  };
}

/** The occurrence just before `latest`, for the last time an older row stands for; `first` when it cannot be found cheaply. */
function lastBefore(schedule: RoutineSchedule, first: number, latest: number): number {
  if (schedule.type === "interval" && !intervalHasRestrictions(schedule)) return latest - schedule.everyMinutes * 60_000;
  let at = first;
  for (let walked = 0; walked < WALK_LIMIT; walked += 1) {
    const next = nextOccurrence(schedule, at);
    if (next === null || next >= latest) return at;
    at = next;
  }
  return at;
}

/** The start of the `index`th late run made in one pass: the first at once, each next one a step later. */
export function staggered(now: number, index: number): Partial<RoutineRun> {
  const step = index % CATCH_UP_STAGGER_STEPS;
  return step === 0 ? {} : { retryAt: now + step * CATCH_UP_STAGGER_MS };
}

const ACTIVE = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

/** After a restore from a backup, with `through` the time until which the schedule it replaced had been alive: every
 * occurrence up to then had its turn before the restore, so none of them runs again. Runs the backup held unfinished
 * are let go, and each routine's occurrences up to then close on one counted row; what came due after `through` is
 * caught up as after any downtime. Returns the rows changed or added. */
export function settleRestored(routines: Routine[], runs: RoutineRun[], through: number | null, now: number, advance: (routine: Routine, past: number) => void): RoutineRun[] {
  if (through === null) return [];
  const changed: RoutineRun[] = [], line = codedLine("error", "routines.server.restored");
  for (const run of runs) {
    if (!ACTIVE.has(run.status) || !isOccurrenceRun(run) || run.scheduledFor > through) continue;
    Object.assign(run, line.codes, { status: "cancelled", attention: undefined, error: line.text, finishedAt: now } satisfies Partial<RoutineRun>);
    if (run.target === "room-goal") run.goalStatus = "stopped";
    changed.push(run);
  }
  for (const routine of routines) {
    if (!routine.enabled || routine.checks || routine.nextRunAt == null || routine.nextRunAt > through || routine.schedule.type === "limit_reset") continue;
    const first = routine.nextRunAt, { latest, count } = passedOccurrences(routine.schedule, first, through);
    const counted = codedLine("error", "routines.server.restoredMany", { count });
    const row: RoutineRun = {
      id: randomUUID(), routineId: routine.id, ...routineRunDefinition(routine), scheduledFor: first, status: "missed", manual: false, triggerSource: "schedule",
      createdAt: now, finishedAt: now, seenAt: now, error: counted.text, ...counted.codes, skipped: { count, firstAt: first, lastAt: latest, behind: `restored:${through}` },
    };
    runs.push(row);
    advance(routine, latest);
    changed.push(row);
  }
  return changed;
}
