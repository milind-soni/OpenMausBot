// What the Chief did for the person, counted when it happens: emails it sorted, replies it drafted, meetings it prepared.
// Counts and times only, in value.json, so the recap, the morning brief's first line and the Admin's health report say
// only what really happened.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

const DAY = 24 * 60 * 60_000;
const KEEP_MS = 14 * DAY;
const MAX_EVENTS = 2_000;
export const VALUE_FILE = "value.json";
export const VALUE_KINDS = ["sorted", "drafted", "prepped"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];
export type ValueCounts = Record<ValueKind, number>;
/** What the counts add up to, with the routine results that came in: `routines` is read from the run history. */
export type ValueTally = ValueCounts & { routines: number };

/** The minutes each piece of work would have taken the person, kept low on purpose: reading and sorting one email,
 * writing one reply, preparing for one meeting, doing one routine's job by hand. */
export const MINUTES_EACH: Readonly<Record<keyof ValueTally, number>> = { sorted: 1, drafted: 5, prepped: 10, routines: 3 };

const count = z.number().int().nonnegative().max(1_000_000_000);
const fileSchema = z.object({
  version: z.literal(1),
  totals: z.object({ sorted: count, drafted: count, prepped: count }),
  events: z.array(z.object({ at: z.number().finite().nonnegative(), kind: z.enum(VALUE_KINDS), n: count })).max(MAX_EVENTS),
});
type ValueFile = z.infer<typeof fileSchema>;

const none = (): ValueCounts => ({ sorted: 0, drafted: 0, prepped: 0 });

/** The counts for the Admin's health report, with the minutes they add up to. */
export type ValueReport = ValueTally & { minutes: number };

export function valueReport(tally: ValueTally): ValueReport {
  return { ...tally, minutes: minutesSaved(tally) };
}

export function minutesSaved(tally: ValueTally): number {
  return (Object.keys(MINUTES_EACH) as Array<keyof ValueTally>).reduce((sum, kind) => sum + tally[kind] * MINUTES_EACH[kind], 0);
}

export const anyValue = (tally: ValueCounts & Partial<ValueTally>): boolean => VALUE_KINDS.some((kind) => tally[kind] > 0) || (tally.routines ?? 0) > 0;

export function createValueLedger(deps: { dataDir: string; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, VALUE_FILE);
  let state: ValueFile = { version: 1, totals: none(), events: [] };
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`value: ${file} is not a value file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`value: ${file} is unreadable; starting fresh`);
  }
  const save = (): void => {
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`value: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    add(kind: ValueKind, n = 1): void {
      if (!Number.isSafeInteger(n) || n <= 0) return;
      const at = now();
      state.totals[kind] += n;
      state.events = [...state.events.filter((event) => at - event.at <= KEEP_MS), { at, kind, n }].slice(-MAX_EVENTS);
      save();
    },
    totals: (): ValueCounts => ({ ...state.totals }),
    /** What was done from `at` on, within the last two weeks. */
    since(at: number): ValueCounts {
      const counts = none();
      for (const event of state.events) if (event.at >= at) counts[event.kind] += event.n;
      return counts;
    },
  };
}

export type ValueLedger = ReturnType<typeof createValueLedger>;
