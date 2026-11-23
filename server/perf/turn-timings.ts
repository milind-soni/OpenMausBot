// Where each bot turn's time went, from the runtime events the server already has: no timer of its own beyond one
// debounced save, no process, no network. O(1) work per event; bounded memory (RING_CAP finished turns, LIVE_CAP live
// ones, the day ledger's fixed slots). Privacy invariant: only a TurnTiming's checked fields leave it.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { Message } from "../store.ts";
import { createDayLedger, DAY_HOURS, SLOW_TURN_MS } from "./day-ledger.ts";
import { exactQuantile, PHASES, type Phase, type PhaseMs, type PhaseStats } from "./phases.ts";
import { parseSetupMs, setupStatsOf, type SetupMs, type SetupStats } from "./setup-steps.ts";
import {
  activeMs, ID, isLimitScope, KIND, matchOr, parseTurnTiming, retryCode, RETRY_WHY_KEPT, stopCode, TOOL_KINDS_KEPT, toolKindOf,
  type FailoverWhy, type LimitScope, type QueueWhy, type ToolKind, type ToolStat, type TurnTiming,
} from "./turn-record.ts";

/** Enough for an hour of 34 bots' turns, so the hour's percentiles are not cut short. */
export const RING_CAP = 1_000;
const LIVE_CAP = 200, PENDING_CAP = 500, OPEN_TOOLS_CAP = 64;
/** A turn whose end never came is taken as over after this long: dropped, or, while it waits on a person, finished as such. */
export const LIVE_TTL_MS = 6 * 3_600_000;
/** A person's message waits for its turn at most this long before it is no longer timed. */
export const PENDING_TTL_MS = 2 * 3_600_000;
/** A move to a backup AI marks the thread's next turn only if that turn starts this soon after. */
const FAILOVER_TTL_MS = 10 * 60_000;
/** The file is written at most this often, and only after a turn ends. */
export const SAVE_EVERY_MS = 60_000;
const HOUR = 3_600_000;

/** What a live turn is doing now; the turn's time is the sum of the time spent in each. */
export type LiveState = "model" | "tool" | "resource" | "person" | "retry";
const STATE_PHASE: Record<LiveState, Phase> = { model: "model", tool: "tool", resource: "resource", person: "person", retry: "retry" };

interface Live {
  key: string;
  turnId: string | null;
  threadId: string | null;
  botId: string | null;
  engine: string | null;
  startedAt: number;
  queueMs?: number;
  queueWhy?: QueueWhy;
  setup?: SetupMs;
  sessionAt: number | null;
  firstOutputAt: number | null;
  state: LiveState;
  stateSince: number;
  spent: Record<LiveState, number>;
  openTools: Map<string, { kind: ToolKind; at: number }>;
  requests: number;
  waits: number;
  retrying: boolean;
  retries: number;
  backoffMs: number;
  retryWhy: string[];
  limit?: LimitScope;
  limitResetsAt?: number;
  failover?: FailoverWhy;
  tools: Map<ToolKind, ToolStat>;
}

export interface LiveTurnView { botId: string | null; threadId: string | null; engine: string | null; ageMs: number; state: LiveState; stateMs: number; tool?: ToolKind; queueMs?: number }

export interface WindowStats { turns: number; failed: number; phases: Partial<Record<Phase, PhaseStats>>; setup: SetupStats; slow: number[]; partial: boolean }

/** What refused a turn before it ran: a usage limit (and on which engine), or a sign-in that expired. */
export interface Refusal { limit?: LimitScope; engine?: string | null; resetsAt?: number; signedOut?: boolean }

/** A slow event worth one log line: a slow turn (its time less any wait on a person), a slow tool call, a usage limit refusing a turn. */
export type SlowNote =
  | { kind: "turn"; turn: TurnTiming }
  | { kind: "tool"; tool: ToolKind; ms: number; ok: boolean; engine: string | null; botId: string | null; threadId: string | null }
  | { kind: "limit"; engine: string | null; scope: LimitScope; resetsAt?: number };

export interface TurnTimingsOptions {
  /** The saved ring and day; absent: memory only. */
  file?: string;
  botOf?: (threadId: string) => string | null;
  now?: () => number;
  slow?: (note: SlowNote) => void;
  /** A turn past this is reported to `slow`. */
  slowTurnMs?: number;
  /** A tool call past this is reported to `slow`. */
  slowToolMs?: number;
}

const stateOf = (live: Live): LiveState =>
  live.requests > 0 ? "person" : live.waits > 0 ? "resource" : live.retrying ? "retry" : live.openTools.size > 0 ? "tool" : "model";

const PERSON_MESSAGE = (message: Pick<Message, "role" | "kind" | "steered" | "aside" | "from" | "peerAsk" | "automation">) =>
  message.role === "user" && message.kind === "text" && !message.steered && !message.aside && !message.from?.botId && !message.peerAsk && !message.automation;

export function createTurnTimings(options: TurnTimingsOptions = {}) {
  const now = options.now ?? Date.now;
  const slowTurnMs = options.slowTurnMs ?? 300_000, slowToolMs = options.slowToolMs ?? 120_000;
  const day = createDayLedger(now);
  const ring: TurnTiming[] = [];
  const live = new Map<string, Live>();
  const pending = new Map<string, { at: number; behind: boolean }>();
  const held = new Map<string, QueueWhy>();
  const failovers = new Map<string, { why: FailoverWhy; at: number }>();
  const setups = new Map<string, { ms: SetupMs; at: number }>();
  let savedAt = -Infinity, saveTimer: ReturnType<typeof setTimeout> | null = null;

  const remember = <V>(map: Map<string, V>, key: string, value: V, cap: number) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > cap) map.delete(map.keys().next().value as string);
  };
  const shift = (turn: Live, at: number) => {
    turn.spent[turn.state] += Math.max(0, at - turn.stateSince);
    turn.stateSince = at;
    turn.state = stateOf(turn);
  };

  const save = () => {
    saveTimer = null;
    if (!options.file) return;
    savedAt = now();
    try { writeFileAtomic(options.file, JSON.stringify({ v: 1, ring, day: day.save() }), { mode: 0o600, durable: false }); } catch {}
  };
  const saveSoon = () => {
    if (!options.file || saveTimer) return;
    saveTimer = setTimeout(save, Math.max(0, savedAt + SAVE_EVERY_MS - now()));
    saveTimer.unref?.();
  };
  if (options.file) {
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as { v?: number; ring?: unknown[]; day?: unknown };
      if (saved?.v === 1) {
        for (const raw of (Array.isArray(saved.ring) ? saved.ring : []).slice(-RING_CAP)) {
          const turn = parseTurnTiming(raw);
          if (turn) ring.push(turn);
        }
        day.load(saved.day);
      }
    } catch {}
  }

  const sweep = (at: number) => {
    for (const [key, turn] of live) {
      if (turn.startedAt >= at - LIVE_TTL_MS) break;
      live.delete(key);
      if (turn.requests > 0) finish(turn, false, "waiting_on_person", at);
    }
  };
  const clearWaiting = (threadId: string) => { pending.delete(threadId); held.delete(threadId); };

  const start = (event: RuntimeEvent, at: number) => {
    const threadId = event.threadId;
    sweep(at);
    const replaced = live.get(threadId);
    if (replaced) { live.delete(threadId); finish(replaced, false, "other", at); }
    const waiting = pending.get(threadId);
    const why = held.get(threadId);
    clearWaiting(threadId);
    const moved = failovers.get(threadId);
    failovers.delete(threadId);
    const failover = moved && at - moved.at <= FAILOVER_TTL_MS ? moved.why : undefined;
    const queueMs = waiting && at - waiting.at <= PENDING_TTL_MS ? Math.max(0, at - waiting.at) : undefined;
    const prepared = setups.get(threadId);
    setups.delete(threadId);
    const setup = prepared && at - prepared.at <= PENDING_TTL_MS ? prepared.ms : undefined;
    const turn: Live = {
      key: threadId, turnId: matchOr(ID, event.turnId, null), threadId: matchOr(ID, threadId, null),
      botId: matchOr(ID, options.botOf?.(threadId), null), engine: matchOr(KIND, event.provider, null), startedAt: at,
      ...(queueMs !== undefined ? { queueMs, queueWhy: why ?? (waiting!.behind ? "behind-turn" : "dispatch") } : {}),
      ...(setup ? { setup } : {}),
      sessionAt: null, firstOutputAt: null, state: "model", stateSince: at, spent: { model: 0, tool: 0, resource: 0, person: 0, retry: 0 },
      openTools: new Map(), requests: 0, waits: 0, retrying: false, retries: 0, backoffMs: 0, retryWhy: [], tools: new Map(),
      ...(failover ? { failover } : {}),
    };
    remember(live, threadId, turn, LIVE_CAP);
  };

  const toolEnded = (turn: Live, call: { kind: ToolKind; at: number }, at: number, ok: boolean, open: boolean) => {
    const ms = Math.max(0, at - call.at);
    const stat = turn.tools.get(call.kind) ?? { kind: call.kind, n: 0, ms: 0, max: 0, errors: 0, open: 0 };
    stat.n += 1; stat.ms += ms; stat.max = Math.max(stat.max, ms);
    if (!ok) stat.errors += 1;
    if (open) stat.open += 1;
    turn.tools.set(call.kind, stat);
    day.noteTool(call.kind, ms, ok, open, at);
    if (ms >= slowToolMs) options.slow?.({ kind: "tool", tool: call.kind, ms, ok: ok && !open, engine: turn.engine, botId: turn.botId, threadId: turn.threadId });
  };

  function finish(turn: Live, ok: boolean, stopReason: unknown, at: number) {
    shift(turn, at);
    for (const call of turn.openTools.values()) toolEnded(turn, call, at, false, true);
    const ms: PhaseMs = { total: Math.max(0, at - turn.startedAt) };
    if (turn.queueMs !== undefined) ms.queue = turn.queueMs;
    if (turn.sessionAt !== null) ms.handshake = Math.max(0, turn.sessionAt - turn.startedAt);
    if (turn.firstOutputAt !== null) ms.ttft = Math.max(0, turn.firstOutputAt - turn.startedAt);
    for (const [state, spent] of Object.entries(turn.spent) as Array<[LiveState, number]>) if (spent > 0 || state === "model") ms[STATE_PHASE[state]] = spent;
    const record: TurnTiming = {
      turnId: turn.turnId, threadId: turn.threadId, botId: turn.botId, engine: turn.engine, startedAt: turn.startedAt, endedAt: at,
      ok, stop: stopCode(ok, stopReason), ms, ...(turn.setup ? { setup: turn.setup } : {}), ...(turn.queueWhy ? { queueWhy: turn.queueWhy } : {}),
      retries: turn.retries, backoffMs: turn.backoffMs, ...(turn.retryWhy.length ? { retryWhy: turn.retryWhy } : {}),
      ...(turn.limit ? { limit: turn.limit } : {}), ...(turn.limitResetsAt ? { limitResetsAt: turn.limitResetsAt } : {}),
      ...(turn.failover ? { failover: turn.failover } : {}),
      tools: [...turn.tools.values()].sort((left, right) => right.ms - left.ms).slice(0, TOOL_KINDS_KEPT),
    };
    ring.push(record);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    day.noteTurn(record);
    if (activeMs(record) >= slowTurnMs) options.slow?.({ kind: "turn", turn: record });
    saveSoon();
  }

  return {
    noteEvent(event: RuntimeEvent) {
      const at = now();
      if (event.type === "turn.started") {
        const current = live.get(event.threadId);
        if (!current || (event.turnId && current.turnId !== matchOr(ID, event.turnId, null))) start(event, at);
        return;
      }
      if (event.type === "runtime.error" && isLimitScope(event.limit)) {
        const turn = live.get(event.threadId);
        if (turn) { turn.limit = event.limit; if (typeof event.limitResetsAt === "number") turn.limitResetsAt = event.limitResetsAt; }
        options.slow?.({ kind: "limit", engine: turn?.engine ?? matchOr(KIND, event.provider, null), scope: event.limit, ...(typeof event.limitResetsAt === "number" ? { resetsAt: event.limitResetsAt } : {}) });
      }
      const turn = live.get(event.threadId);
      if (!turn || (event.turnId && turn.turnId && event.turnId !== turn.turnId)) return;
      if (turn.retrying && event.type !== "turn.retrying") turn.retrying = false;
      switch (event.type) {
        case "session.started": turn.sessionAt ??= at; break;
        case "content.delta": case "item.started": case "request.opened": turn.firstOutputAt ??= at; break;
        case "item.completed": if (event.itemType === "assistant_text") turn.firstOutputAt ??= at; break;
      }
      switch (event.type) {
        case "turn.completed": live.delete(event.threadId); return finish(turn, event.ok, event.stopReason, at);
        case "item.started":
          if (event.itemType === "tool" && turn.openTools.size < OPEN_TOOLS_CAP) turn.openTools.set(event.itemId ?? `#${turn.openTools.size}`, { kind: toolKindOf(event.title, event.summary), at });
          break;
        case "item.completed": {
          if (event.itemType !== "tool") break;
          const id = event.itemId && turn.openTools.has(event.itemId) ? event.itemId : turn.openTools.keys().next().value;
          const call = id === undefined ? undefined : turn.openTools.get(id);
          if (call && id !== undefined) { shift(turn, at); turn.openTools.delete(id); toolEnded(turn, call, at, event.ok, false); }
          break;
        }
        case "request.opened": turn.requests += 1; break;
        case "request.resolved": turn.requests = Math.max(0, turn.requests - 1); break;
        case "turn.wait_started": turn.waits += 1; break;
        case "turn.wait_ended": turn.waits = Math.max(0, turn.waits - 1); break;
        case "turn.retrying":
          turn.retries += 1;
          turn.backoffMs += Math.max(0, Math.min(Number(event.delayMs) || 0, HOUR));
          if (turn.retryWhy.length < RETRY_WHY_KEPT) turn.retryWhy.push(retryCode(event.reason));
          turn.retrying = true;
          break;
      }
      if (stateOf(turn) !== turn.state) shift(turn, at);
    },
    /** Every message the store appends: a person's message starts their wait for a turn; a reply or a failure row while
     * no turn runs ends that wait unanswered. Other bot rows do not: wait notices are posted while the turn waits. */
    noteMessage(threadId: string, message: Pick<Message, "at" | "role" | "kind" | "steered" | "aside" | "from" | "peerAsk" | "automation" | "tool">, arrivedAt?: number) {
      if (message.role !== "user") {
        if (!live.has(threadId) && (message.kind === "text" || message.tool?.ok === false)) clearWaiting(threadId);
        return;
      }
      const waiting = pending.get(threadId);
      if (!PERSON_MESSAGE(message) || (waiting && message.at - waiting.at <= PENDING_TTL_MS)) return;
      // The wait starts when the request carrying the message arrived: work the server did before storing it is part of it.
      remember(pending, threadId, { at: Math.min(message.at, arrivedAt ?? message.at), behind: live.has(threadId) }, PENDING_CAP);
    },
    /**
     * A turn this thread was dispatching never ran (`turnId`, the id the driver refused it under). Its wait ends; a turn
     * the engine had already announced under that id is finished as refused; a usage limit counts even with no turn.
     */
    noteNotStarted(threadId: string, turnId: string | null, refusal: Refusal = {}) {
      const at = now();
      clearWaiting(threadId);
      setups.delete(threadId);
      const turn = live.get(threadId);
      const engine = refusal.engine === undefined ? turn?.engine ?? null : matchOr(KIND, refusal.engine, null);
      const limit = isLimitScope(refusal.limit) ? refusal.limit : undefined;
      const resetsAt = typeof refusal.resetsAt === "number" && Number.isFinite(refusal.resetsAt) ? refusal.resetsAt : undefined;
      if (limit) options.slow?.({ kind: "limit", engine, scope: limit, ...(resetsAt ? { resetsAt } : {}) });
      if (turn && turnId !== null && turn.turnId === matchOr(ID, turnId, null)) {
        live.delete(threadId);
        if (limit) { turn.limit = limit; if (resetsAt) turn.limitResetsAt = resetsAt; }
        return finish(turn, false, limit ? "quota" : refusal.signedOut ? "auth_required" : "other", at);
      }
      if (limit) { day.noteRefusal(engine, limit, at); saveSoon(); }
    },
    /** This thread's turn is set up and its engine is about to be asked: its next turn to start carries these timings. */
    noteSetup(threadId: string, ms: unknown) {
      const setup = parseSetupMs(ms);
      if (setup) remember(setups, threadId, { ms: setup, at: now() }, PENDING_CAP);
    },
    /** This thread's next turn waits for a place: under the plan's limit on turns at once, or for memory. */
    noteHeld(threadId: string, why: "plan-limit" | "memory") { remember(held, threadId, why, PENDING_CAP); },
    /** This thread moved to another AI: a usage limit, or its AI signed out. */
    noteFailover(threadId: string, why: FailoverWhy) {
      const turn = live.get(threadId);
      if (turn) turn.failover = why; else remember(failovers, threadId, { why, at: now() }, PENDING_CAP);
    },
    /** The latest finished turns, newest last, in these threads or of these bots when given. */
    recent(filter: { threadIds?: readonly string[]; botIds?: readonly string[]; limit?: number } = {}): TurnTiming[] {
      const threads = new Set(filter.threadIds ?? []), bots = new Set(filter.botIds ?? []);
      const all = !threads.size && !bots.size;
      const picked = ring.filter((turn) => all || (turn.threadId !== null && threads.has(turn.threadId)) || (turn.botId !== null && bots.has(turn.botId)));
      return picked.slice(-(filter.limit ?? RING_CAP)).map((turn) => ({ ...turn, ms: { ...turn.ms }, ...(turn.setup ? { setup: { ...turn.setup } } : {}), tools: turn.tools.map((tool) => ({ ...tool })) }));
    },
    /** Exact percentiles over the turns that ended in the last `windowMs`, from the ring; `partial` when the ring is full
     * and its oldest turn ended inside the window, so turns before it are missing. */
    window(windowMs = HOUR): WindowStats {
      const from = now() - windowMs;
      const turns = ring.filter((turn) => turn.endedAt > from);
      const phases: Partial<Record<Phase, PhaseStats>> = {};
      for (const phase of PHASES) {
        const values = turns.flatMap((turn) => (turn.ms[phase] === undefined ? [] : [turn.ms[phase]])).sort((left, right) => left - right);
        if (values.length) phases[phase] = { p50: exactQuantile(values, 0.5), p95: exactQuantile(values, 0.95), max: values.at(-1)!, n: values.length };
      }
      const slow = SLOW_TURN_MS.map((edge) => turns.filter((turn) => activeMs(turn) > edge).length);
      return { turns: turns.length, failed: turns.filter((turn) => !turn.ok).length, phases, setup: setupStatsOf(turns), slow, partial: ring.length >= RING_CAP && ring[0]!.endedAt > from };
    },
    day: (windowMs = DAY_HOURS * HOUR) => day.read(windowMs),
    /** Whether any turn runs now: cheap enough to ask before each file the storage walk reads. */
    running(): boolean { sweep(now()); return live.size > 0; },
    live(): LiveTurnView[] {
      const at = now();
      sweep(at);
      return [...live.values()].map((turn) => {
        const oldest = turn.openTools.values().next().value;
        return { botId: turn.botId, threadId: turn.threadId, engine: turn.engine, ageMs: Math.max(0, at - turn.startedAt), state: turn.state, stateMs: Math.max(0, at - turn.stateSince),
          ...(oldest ? { tool: oldest.kind } : {}), ...(turn.queueMs !== undefined ? { queueMs: turn.queueMs } : {}) };
      }).sort((left, right) => right.ageMs - left.ageMs);
    },
    /** The engine kind this thread's turns run on, from its live turn or its latest finished one. */
    engineOf(threadId: string): string | null {
      const turn = live.get(threadId);
      if (turn) return turn.engine;
      for (let index = ring.length - 1; index >= 0; index--) if (ring[index]!.threadId === threadId) return ring[index]!.engine;
      return null;
    },
    /** Writes now (tests, and a clean exit). */
    flush() { if (saveTimer) clearTimeout(saveTimer); save(); },
  };
}
export type TurnTimings = ReturnType<typeof createTurnTimings>;
