// The last day of turn timings by hour: one histogram per phase and per tool kind, and counts. Bounded at 25 hours of
// fixed-size slots whatever the traffic.
import { addTo, countOf, emptyHistogram, histogramQuantile, mergeInto, parseHistogram, PHASES, type Histogram, type Phase, type PhaseStats } from "./phases.ts";
import { SETUP_STEPS, type SetupStats, type SetupStep } from "./setup-steps.ts";
import { activeMs, counter, isLimitScope, isRetryCode, isToolKind, KIND, type LimitScope, type ToolKind, type TurnTiming } from "./turn-record.ts";

const HOUR = 3_600_000;
export const DAY_HOURS = 24;
/** A turn counts as slow past each of these (ms) of its time less any wait on a person. */
export const SLOW_TURN_MS = [60_000, 300_000, 900_000] as const;
const REASONS_KEPT = 12, LIMIT_KEYS_KEPT = 12;

interface ToolSlot { hist: Histogram; errors: number; open: number }
interface Slot {
  hour: number;
  turns: number;
  failed: number;
  slow: number[];
  phases: Partial<Record<Phase, Histogram>>;
  setup: Partial<Record<SetupStep, Histogram>>;
  tools: Partial<Record<ToolKind, ToolSlot>>;
  retries: { turns: number; n: number; backoffMs: number; why: Record<string, number> };
  /** Turns a usage limit refused, by `<engine kind>:<scope>`. */
  limits: Record<string, number>;
  failovers: number;
}

const emptySlot = (hour: number): Slot => ({ hour, turns: 0, failed: 0, slow: SLOW_TURN_MS.map(() => 0), phases: {}, setup: {}, tools: {},
  retries: { turns: 0, n: 0, backoffMs: 0, why: counter() }, limits: counter(), failovers: 0 });

const bump = (map: Record<string, number>, key: string, cap: number, by = 1) => {
  if (!Object.hasOwn(map, key) && Object.keys(map).length >= cap) key = "other";
  map[key] = (map[key] ?? 0) + by;
};

export interface ToolAggregate { kind: ToolKind; n: number; errors: number; open: number; ms: number; p95: number; max: number }
export interface DayAggregate {
  turns: number;
  failed: number;
  phases: Partial<Record<Phase, PhaseStats>>;
  /** Bucketed like the phases: a step under the first bucket's edge reads as that edge at most. */
  setup: SetupStats;
  slow: number[];
  tools: ToolAggregate[];
  retries: { turns: number; n: number; backoffMs: number; why: Record<string, number> };
  limits: Record<string, number>;
  failovers: number;
}

const statsOf = (histogram: Histogram): PhaseStats =>
  ({ p50: histogramQuantile(histogram, 0.5), p95: histogramQuantile(histogram, 0.95), max: histogram.max, n: countOf(histogram) });

export function createDayLedger(now: () => number) {
  const slots = new Map<number, Slot>();
  const slot = (at: number): Slot => {
    const hour = Math.floor(at / HOUR);
    let found = slots.get(hour);
    if (!found) {
      found = emptySlot(hour);
      slots.set(hour, found);
      for (const key of slots.keys()) if (key <= hour - DAY_HOURS) slots.delete(key);
    }
    return found;
  };

  return {
    noteTool(kind: ToolKind, ms: number, ok: boolean, open: boolean, at = now()) {
      const tools = slot(at).tools;
      const entry = tools[kind] ??= { hist: emptyHistogram(), errors: 0, open: 0 };
      addTo(entry.hist, ms);
      if (!ok) entry.errors += 1;
      if (open) entry.open += 1;
    },
    noteTurn(turn: TurnTiming) {
      const into = slot(turn.endedAt);
      into.turns += 1;
      if (!turn.ok) into.failed += 1;
      for (const phase of PHASES) {
        const ms = turn.ms[phase];
        if (ms !== undefined) addTo(into.phases[phase] ??= emptyHistogram(), ms);
      }
      for (const step of SETUP_STEPS) {
        const ms = turn.setup?.[step];
        if (ms !== undefined) addTo(into.setup[step] ??= emptyHistogram(), ms);
      }
      const active = activeMs(turn);
      SLOW_TURN_MS.forEach((edge, index) => { if (active > edge) into.slow[index]! += 1; });
      if (turn.retries) {
        into.retries.turns += 1; into.retries.n += turn.retries; into.retries.backoffMs += turn.backoffMs;
        for (const why of turn.retryWhy ?? []) bump(into.retries.why, why, REASONS_KEPT);
      }
      if (turn.limit) bump(into.limits, `${turn.engine ?? "unknown"}:${turn.limit}`, LIMIT_KEYS_KEPT);
      if (turn.failover) into.failovers += 1;
    },
    /** A usage limit refused a turn before it started: no turn to time, but the refusal counts. */
    noteRefusal(engine: string | null, scope: LimitScope, at = now()) {
      bump(slot(at).limits, `${engine ?? "unknown"}:${scope}`, LIMIT_KEYS_KEPT);
    },
    read(windowMs: number = DAY_HOURS * HOUR): DayAggregate {
      const from = Math.floor((now() - windowMs) / HOUR);
      const phases: Partial<Record<Phase, Histogram>> = {};
      const tools: Partial<Record<ToolKind, ToolSlot>> = {};
      const setup: Partial<Record<SetupStep, Histogram>> = {};
      const out: DayAggregate = { turns: 0, failed: 0, phases: {}, setup: {}, slow: SLOW_TURN_MS.map(() => 0), tools: [],
        retries: { turns: 0, n: 0, backoffMs: 0, why: counter() }, limits: counter(), failovers: 0 };
      for (const entry of slots.values()) {
        if (entry.hour <= from) continue;
        out.turns += entry.turns; out.failed += entry.failed; out.failovers += entry.failovers;
        entry.slow.forEach((count, index) => { out.slow[index]! += count; });
        for (const [phase, histogram] of Object.entries(entry.phases) as Array<[Phase, Histogram]>) mergeInto(phases[phase] ??= emptyHistogram(), histogram);
        for (const [step, histogram] of Object.entries(entry.setup) as Array<[SetupStep, Histogram]>) mergeInto(setup[step] ??= emptyHistogram(), histogram);
        for (const [kind, tool] of Object.entries(entry.tools) as Array<[ToolKind, ToolSlot]>) {
          const into = tools[kind] ??= { hist: emptyHistogram(), errors: 0, open: 0 };
          mergeInto(into.hist, tool.hist); into.errors += tool.errors; into.open += tool.open;
        }
        out.retries.turns += entry.retries.turns; out.retries.n += entry.retries.n; out.retries.backoffMs += entry.retries.backoffMs;
        for (const [why, count] of Object.entries(entry.retries.why)) bump(out.retries.why, why, REASONS_KEPT, count);
        for (const [key, count] of Object.entries(entry.limits)) bump(out.limits, key, LIMIT_KEYS_KEPT, count);
      }
      for (const phase of PHASES) if (phases[phase]) out.phases[phase] = statsOf(phases[phase]);
      for (const step of SETUP_STEPS) if (setup[step]) out.setup[step] = statsOf(setup[step]);
      out.tools = (Object.entries(tools) as Array<[ToolKind, ToolSlot]>)
        .map(([kind, tool]) => ({ kind, n: countOf(tool.hist), errors: tool.errors, open: tool.open, ms: tool.hist.sum, p95: histogramQuantile(tool.hist, 0.95), max: tool.hist.max }))
        .sort((left, right) => right.ms - left.ms);
      return out;
    },
    save: (): Slot[] => [...slots.values()],
    load(saved: unknown) {
      if (!Array.isArray(saved)) return;
      const oldest = Math.floor(now() / HOUR) - DAY_HOURS;
      for (const raw of saved.slice(-DAY_HOURS - 1) as Array<Record<string, unknown>>) {
        const parsed = parseSlot(raw);
        if (parsed && parsed.hour > oldest) slots.set(parsed.hour, parsed);
      }
    },
  };
}
export type DayLedger = ReturnType<typeof createDayLedger>;

const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const codes = (value: unknown, accept: (key: string) => boolean, cap: number): Record<string, number> => {
  const out = counter();
  for (const [key, count] of Object.entries((value && typeof value === "object" ? value : {}) as Record<string, unknown>).slice(0, cap)) {
    if (accept(key)) out[key] = whole(count);
  }
  return out;
};
const limitKey = (key: string) => key === "other" || (isLimitScope(key.slice(key.lastIndexOf(":") + 1)) && KIND.test(key.slice(0, key.lastIndexOf(":"))));
const reasonKey = (key: string) => isRetryCode(key);

function parseSlot(raw: Record<string, unknown> | null): Slot | null {
  if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.hour)) return null;
  const slot = emptySlot(raw.hour as number);
  slot.turns = whole(raw.turns); slot.failed = whole(raw.failed); slot.failovers = whole(raw.failovers);
  if (Array.isArray(raw.slow)) slot.slow = SLOW_TURN_MS.map((_, index) => whole((raw.slow as unknown[])[index]));
  for (const phase of PHASES) {
    const value = (raw.phases as Record<string, unknown> | undefined)?.[phase];
    if (value) slot.phases[phase] = parseHistogram(value);
  }
  for (const step of SETUP_STEPS) {
    const value = (raw.setup as Record<string, unknown> | undefined)?.[step];
    if (value) slot.setup[step] = parseHistogram(value);
  }
  for (const [kind, value] of Object.entries((raw.tools ?? {}) as Record<string, Record<string, unknown>>)) {
    if (isToolKind(kind) && value) slot.tools[kind] = { hist: parseHistogram(value.hist), errors: whole(value.errors), open: whole(value.open) };
  }
  const retries = (raw.retries ?? {}) as Record<string, unknown>;
  slot.retries = { turns: whole(retries.turns), n: whole(retries.n), backoffMs: whole(retries.backoffMs), why: codes(retries.why, reasonKey, REASONS_KEPT) };
  slot.limits = codes(raw.limits, limitKey, LIMIT_KEYS_KEPT);
  return slot;
}
