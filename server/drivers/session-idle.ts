// The one idle policy for what the server keeps loaded between turns. Each kept thing has a scope, named as such here and
// at each call site:
//   per-chat  a conversation's engine session (Claude's stream, an ACP session in a process of its own), kept for that
//             conversation's next turn: OMB_SESSION_IDLE_MS (10 minutes; 150 s on a box of 1.5 GB or less), 30 s for a
//             conversation no person has in front of them, and while a person asked a prompt-cache keep-warm, until then.
//   per-bot   a bot's browser, kept for any of its conversations: the browser idle time (Settings, 10 minutes on the
//             desktop, 3 on a Cloud home; host/browser.ts).
//   shared    a process several bots' conversations use (a shared ACP process): recycled 60 s after its last session
//             (OMB_ACP_SHARED_RECYCLE_MS), a fixed time that does not shrink.
// Where turns wait for room (a Cloud home, a self-hosted Linux server), the per-chat and per-bot times shrink as memory or
// the pids limit fills (EngineMemory.roomFactor: the signals admission reads), down to a tenth and never below their
// floor, and per-chat engines already kept are looked at again every couple of seconds (sweepIdleEngines), not only when
// they went idle. Short of room, a keep-warm hold yields too. Before admission makes a new engine wait it stops the
// engine idle longest (engine-memory.ts), and a browser with no room to open asks for the same first (host/browser.ts).
// On every host, no more per-chat engines stay idle at once than idleEngineCap allows: past it, the least recently used
// closes as another goes idle, and its conversation's next turn resumes its session by id.
import { availableMemory, boxMemory, type BoxMemory } from "../box-memory.ts";
import { stoppedForBotMemory } from "../bot-memory-cap.ts";
import { ENGINE_MAX_BYTES, engineMemory, type EngineMemory } from "../engine-memory.ts";
import { onThreadSeen, seenWithin } from "../thread-presence.ts";

export type IdleScope = "per-chat" | "per-bot" | "shared";

/** What the room allows of an idle time: the time scaled by `factor` (1 with room to spare, down to 0.1), never below
 * `minimumMs`. */
export const idleAfter = (baseMs: number, minimumMs: number, factor: number): number => Math.max(minimumMs, Math.round(baseMs * Math.min(1, Math.max(0.1, factor))));

export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
  /** An engine whose cold start costs tens of seconds, with no idle time configured: where turns wait for room, how long
   * its idle process stays up for a watched conversation while the room holds one more of the largest engines. */
  expensiveIdleMs?: number;
}

/** What a driver says a cold start of its engine costs: "expensive" for one that takes tens of seconds (Google's packaged
 * Antigravity server, a ~1 GB runtime that unpacks and loads its own Python before it answers). */
export type ColdStartCost = "expensive";
/** Where turns wait for room, an expensive engine's idle process for a watched conversation stays up this long while the
 * room allows (the time a reference ACP client keeps an idle Antigravity process), and this long for an unwatched one. */
export const EXPENSIVE_IDLE_MS = 30 * 60_000;
export const EXPENSIVE_UNWATCHED_IDLE_MS = 3 * 60_000;

/** Room for one more of the largest engines admission plans for (ENGINE_MAX_BYTES) above the memory floor, besides this
 * idle one: headroom is (free - floor) / (total / 2), so that is a factor of at least ENGINE_MAX_BYTES / (total / 2). Never
 * on a box under 3 GB, whose whole headroom is less than that engine; on a 3 GB box only with all of it free. */
export function roomBesideIdle(factor: number, boxBytes: number): boolean {
  return boxBytes > SMALL_BOX_BYTES && Math.min(1, factor) * (boxBytes / 2) >= ENGINE_MAX_BYTES;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
/** One warm engine and its MCP servers take 250 to 450 MB: on a box this small an idle one is soon given back, and the
 * next turn resumes its session by id. */
export const SMALL_BOX_BYTES = 1.5 * 1024 ** 3;
export const SMALL_BOX_IDLE_MS = 150_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** Per-harness names (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) win over OMB_SESSION_IDLE_MS /
 *  OMB_SESSION_IDLE_MIN_MS, which win over the box's default; the floor is the greater of ten seconds and any configured
 *  minimum. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
  boxBytes: number = boxMemory().bytes,
  coldStart?: ColdStartCost,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.OMB_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MS`] ?? env.OMB_SESSION_IDLE_MS,
    ) ?? (boxBytes <= SMALL_BOX_BYTES ? SMALL_BOX_IDLE_MS : DEFAULT_IDLE_MS);
  const idleMs = Math.max(minimumMs, configured);
  const chosen = usableMilliseconds(env[`OMB_${driverPrefix}_SESSION_IDLE_MS`] ?? env.OMB_SESSION_IDLE_MS) !== null;
  return { idleMs, minimumMs, ...(coldStart === "expensive" && !chosen && boxBytes > SMALL_BOX_BYTES ? { expensiveIdleMs: Math.max(idleMs, EXPENSIVE_IDLE_MS) } : {}) };
}

/** On a small box with less than half of it free, a second idle engine would leave no room for a turn's own engine. On a
 * self-hosted server whose memory or pids limit holds only so many engines (`fits`), no more stay idle than fit beside the
 * ones working: each holds its processes and threads against that limit while it waits. */
export function idleEnginesAllowed(box: Pick<BoxMemory, "bytes">, availableBytes: number, fits: number = Infinity): number {
  return Math.min(fits, box.bytes <= SMALL_BOX_BYTES && availableBytes < box.bytes / 2 ? 1 : Infinity);
}

export interface WarmEngine {
  /** Still idle and free to close: no turn running. */
  idle: () => boolean;
  close: () => void;
  /** A per-chat engine's conversation and policy: the sweep works its idle time out again as the room changes. */
  threadId?: string;
  policy?: SessionIdlePolicy;
  /** Kept on purpose until a time (a prompt-cache keep-warm): only a shortage of room closes it before then. */
  held?: () => boolean;
  /** Started before any message and not yet used by a turn: the first to close when room is short. */
  spare?: () => boolean;
}

const GB = 1024 ** 3;
export const SMALL_BOX_IDLE_ENGINES = 2;
const IDLE_ENGINES_FEWEST = 4, IDLE_ENGINES_MOST = 8;

/** How many engines may stay idle at once across every driver and conversation, whatever the idle times allow:
 * OMB_IDLE_ENGINES_MAX (1 or more), else one per 2 GB of the box between four and eight, and two on a box of 1.5 GB or
 * less. Each holds 250 to 450 MB with its MCP servers. */
export function idleEngineCap(env: Record<string, string | undefined> = process.env, boxBytes: number = boxMemory().bytes): number {
  const configured = Number(env.OMB_IDLE_ENGINES_MAX);
  if (env.OMB_IDLE_ENGINES_MAX && Number.isInteger(configured) && configured >= 1) return configured;
  if (boxBytes <= SMALL_BOX_BYTES) return SMALL_BOX_IDLE_ENGINES;
  return Math.min(IDLE_ENGINES_MOST, Math.max(IDLE_ENGINES_FEWEST, Math.floor(boxBytes / (2 * GB))));
}

/** Idle engines of every driver, the least recently used first: an engine moves to the end when it goes idle and when a
 * person opens or reads its conversation. */
const warmEngines = new Map<string, WarmEngine>();

/** An engine went idle: when the box allows fewer idle engines than are up, the ones idle longest close now (an engine
 * started ahead of a first message before them); past the cap on idle engines, the least recently used close now (one
 * whose conversation no person has had in front of them before them). Never one with a turn running, nor one held. */
export function keepWarm(key: string, engine: WarmEngine, box: Pick<BoxMemory, "bytes"> = boxMemory(),
  available: () => number = availableMemory, fits: () => number = () => engineMemory.idleEnginesAllowed(),
  cap: () => number = () => idleEngineCap(process.env, box.bytes)): void {
  warmEngines.delete(key);
  warmEngines.set(key, engine);
  for (const [other, warm] of warmEngines) if (other !== key && (!warm.idle() || warm.held?.())) warmEngines.delete(other);
  const most = fits();
  const roomAllows = box.bytes > SMALL_BOX_BYTES && most === Infinity ? Infinity : idleEnginesAllowed(box, available(), most);
  const idleBefore = () => [...warmEngines].filter(([other]) => other !== key);
  closeKept(sparesFirst(idleBefore()).slice(0, Math.max(0, warmEngines.size - roomAllows)));
  closeKept(unwatchedFirst(idleBefore()).slice(0, Math.max(0, warmEngines.size - Math.max(1, cap()))));
}

function closeKept(engines: Array<[string, WarmEngine]>): void {
  for (const [key, warm] of engines) {
    warmEngines.delete(key);
    const entry = armed.get(key);
    if (entry) clearTimeout(entry.timer);
    armed.delete(key);
    warm.close();
  }
}

const sparesFirst = (engines: Array<[string, WarmEngine]>): Array<[string, WarmEngine]> =>
  [...engines.filter(([, warm]) => warm.spare?.()), ...engines.filter(([, warm]) => !warm.spare?.())];

const watched = (warm: WarmEngine): boolean => warm.threadId !== undefined && seenWithin(warm.threadId, WATCHED_MS);
const unwatchedFirst = (engines: Array<[string, WarmEngine]>): Array<[string, WarmEngine]> =>
  [...engines.filter(([, warm]) => !watched(warm)), ...engines.filter(([, warm]) => watched(warm))];

/** A person opened or read a conversation: its idle engines become the most recently used. */
function touchWarm(threadId: string): void {
  const touched = [...warmEngines].filter(([, warm]) => warm.threadId === threadId);
  for (const [key, warm] of touched) {
    warmEngines.delete(key);
    warmEngines.set(key, warm);
  }
}
onThreadSeen(touchWarm);

/** Every per-chat engine idle now, with when it went idle: what the sweep looks at again. */
const armed = new Map<string, { engine: WarmEngine; since: number; timer: ReturnType<typeof setTimeout> }>();

/** Closes an idle per-chat engine after `ms`, sooner on a small box once another engine goes idle after it, and sooner
 * still once the room shrinks its idle time (sweepIdleEngines). */
export function armIdleClose(key: string, ms: number, engine: WarmEngine, now: number = Date.now()): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    // A stale timer (`timer` not the one armed under `key` now, as in stopIdleClose) leaves a later arm's entry alone.
    if (armed.get(key)?.timer !== timer) return;
    armed.delete(key);
    // No longer idle (a turn took it again) or still held: its driver arms it again when it next goes idle.
    if (!engine.idle() || engine.held?.()) return;
    engine.close();
  }, ms);
  timer.unref?.();
  armed.set(key, { engine, since: now, timer });
  keepWarm(key, engine);
  return timer;
}

/** The engine is busy again or gone: its timer stops and it is no longer kept idle. A session ending with an old timer
 * (`timer` not the one armed under `key` now) leaves a later session's entry alone. */
export function stopIdleClose(key: string, timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
  const entry = armed.get(key);
  if (timer && entry && entry.timer !== timer) return;
  warmEngines.delete(key);
  armed.delete(key);
}

/** Closes each idle per-chat engine kept past what the room allows now; short of room, a keep-warm hold too. Runs on
 * engine-memory's tick. Returns how many it closed. */
export function sweepIdleEngines(memory: Pick<EngineMemory, "enabled" | "headroom" | "roomFactor" | "shortOfRoom"> = engineMemory, now: number = Date.now(), boxBytes: number = boxMemory().bytes): number {
  if (!memory.enabled || !armed.size) return 0;
  const factor = memory.roomFactor(), short = memory.shortOfRoom();
  if (factor >= 1 && !short) return 0;
  let closed = 0;
  for (const [key, { engine, since }] of armed) {
    // No longer idle (a turn took it again, or it ended): its driver arms it again when it next goes idle.
    if (!engine.idle()) { armed.delete(key); continue; }
    if (!engine.threadId || !engine.policy || (engine.held?.() && !short)) continue;
    if (!engine.spare?.() && now - since < engineIdleMs(engine.threadId, engine.policy, { enabled: true, headroom: () => factor, roomFactor: () => factor }, now, boxBytes)) continue;
    armed.delete(key);
    warmEngines.delete(key);
    engine.close();
    closed += 1;
  }
  return closed;
}
engineMemory.useIdleSweep(() => void sweepIdleEngines());

/** How many per-chat engines are kept idle now: for tests. */
export const armedIdleCount = (): number => armed.size;

export function warmEngineKeys(): string[] {
  return [...warmEngines.keys()];
}

/** A person wrote in, opened or read the thread this recently: it is the conversation in front of them. */
const WATCHED_MS = 30 * 60_000;
/** A thread nobody has in front of them (a teammate's delegated work, a routine) keeps its engine this long. */
export const UNWATCHED_IDLE_MS = 30_000;

/** An engine started before any message (a person just made a conversation) waits this long for the first one: the time
 * an engine nobody is looking at is already kept, and longer than writing a first line usually takes. */
export const PRESTART_IDLE_MS = UNWATCHED_IDLE_MS;
/** Each waiting engine holds 250 to 450 MB, so only this many wait at once. */
export const PRESTART_MOST = 2;

/** Engines start ahead of a message only where memory is not rationed: never on a small box, and never where turns wait
 * for room (a Cloud home, a self-hosted server), whose admission counts the engines a turn starts. */
export function prestartAllowed(box: Pick<BoxMemory, "bytes"> = boxMemory(), memory: Pick<EngineMemory, "enabled"> = engineMemory): boolean {
  return !memory.enabled && box.bytes > SMALL_BOX_BYTES;
}

/**
 * How long one conversation's idle engine (per-chat) stays up after a turn. Where turns wait for room (a Cloud home, a
 * self-hosted Linux server): briefly for a thread no person has had in front of them lately, and for the one they have,
 * the configured time scaled by the room left (memory and, under a pids limit, processes; down to a tenth). An engine whose
 * cold start is expensive keeps EXPENSIVE_IDLE_MS (watched) or EXPENSIVE_UNWATCHED_IDLE_MS (unwatched) instead while the
 * room holds one more of the largest engines beside it (roomBesideIdle); the sweep shortens it again as soon as it does
 * not, and admission stops it first when another engine needs the room. Elsewhere the configured time: with no memory to
 * read there, nothing could shorten a longer one later.
 */
export function engineIdleMs(threadId: string, policy: SessionIdlePolicy,
  memory: Pick<EngineMemory, "enabled" | "headroom"> & Partial<Pick<EngineMemory, "roomFactor">> = engineMemory, now: number = Date.now(),
  boxBytes: number = boxMemory().bytes): number {
  if (!memory.enabled) return policy.idleMs;
  const factor = memory.roomFactor?.() ?? memory.headroom();
  const roomy = policy.expensiveIdleMs !== undefined && roomBesideIdle(factor, boxBytes);
  if (!seenWithin(threadId, WATCHED_MS, now)) {
    return Math.max(policy.minimumMs, roomy ? EXPENSIVE_UNWATCHED_IDLE_MS : Math.min(policy.idleMs, UNWATCHED_IDLE_MS));
  }
  return roomy ? policy.expensiveIdleMs! : idleAfter(policy.idleMs, policy.minimumMs, factor);
}

/** Whether this thread's engine (`pid`, the process that exited) was just stopped to make room, or for want of it, or for
 * its bot's memory cap (bot-memory-cap.ts): a driver does not start it again at once, into the same shortage. */
export const stoppedForRoom = (threadId: string, pid?: number): boolean => engineMemory.stoppedForRoom(threadId, pid) || stoppedForBotMemory(threadId, pid);
