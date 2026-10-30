// Boat answers about 1,000 API requests a minute per IP and one screen costs two (a command, then reading the file),
// so the Team map shares a small global frame budget and leaves the rest to the bots' own computer calls.
import type { MapComputerState } from "../shared/map-computer.ts";
import { SLEEPING_BOAT_STATES } from "./boat.ts";

/** A cloud computer this installation manages, keyed by its owner: a bot id, or a team computer's owner key. */
export interface FrameMachine {
  owner: string;
  boxId: string;
  state: string;
}

export interface MapFrame {
  data: string;
  mime: string;
  at: number;
  /** `turn`: captured by the bot's own turn, full size. `map`: a small capture made for map watchers. */
  source: "turn" | "map";
  version: string;
}

export interface ComputerFramesOptions {
  /** One provider listing; null when it could not be read. */
  listMachines(): Promise<FrameMachine[] | null>;
  /** Only ever called for a machine the last listing showed running. */
  capture(boxId: string, signal: AbortSignal): Promise<{ data: string; mime: string }>;
  turnFrame(boxId: string): { data: string; mime: string; at: number } | undefined;
  working(owner: string): boolean;
  /** A person controls this computer: nothing on it may be captured. */
  held(owner: string): boolean;
  /** Provider settings are changing: no provider call at all. */
  paused?(): boolean;
  now?(): number;
  framesPerSecond?: number;
  concurrency?: number;
  workingIntervalMs?: number;
  idleIntervalMs?: number;
  /** A turn frame this recent means the bot's own turn is feeding the machine's screen. */
  turnFeedMs?: number;
  /** While a turn feeds the screen, capture only when the newest frame is this old. */
  turnStaleMs?: number;
  inventoryMs?: number;
  /** Watching stops this long after the last map request. */
  watchMs?: number;
  tickMs?: number;
  captureTimeoutMs?: number;
}

const RUNNING = new Set(["idle", "ready", "running"]);
const STARTING = new Set(["init", "provisioning", "provisioned", "cloning"]);
const FAILED = new Set(["error", "cancelled"]);
const MAX_BACKOFF_MS = 120_000;

export function mapComputerState(machine: FrameMachine | undefined, working: boolean): MapComputerState {
  if (!machine) return "off";
  if (RUNNING.has(machine.state)) return working ? "working" : "idle";
  if (STARTING.has(machine.state)) return "starting";
  if (SLEEPING_BOAT_STATES.has(machine.state)) return "asleep";
  if (FAILED.has(machine.state)) return "problem";
  return "off";
}

/** A token bucket: `perSecond` captures a second on average, never more than one second's worth at once. */
export function createFrameBudget(perSecond: number, now: () => number) {
  let tokens = perSecond;
  let refilledAt = now();
  return {
    take(): boolean {
      const at = now();
      tokens = Math.min(perSecond, tokens + ((at - refilledAt) / 1_000) * perSecond);
      refilledAt = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export function createComputerFrames(options: ComputerFramesOptions) {
  const now = options.now ?? Date.now;
  const framesPerSecond = options.framesPerSecond ?? 4;
  const concurrency = options.concurrency ?? 3;
  const workingIntervalMs = options.workingIntervalMs ?? 4_000;
  const idleIntervalMs = options.idleIntervalMs ?? 30_000;
  const turnFeedMs = options.turnFeedMs ?? 20_000;
  const turnStaleMs = options.turnStaleMs ?? 10_000;
  const inventoryMs = options.inventoryMs ?? 10_000;
  const watchMs = options.watchMs ?? 6_000;
  const tickMs = options.tickMs ?? 250;
  const captureTimeoutMs = options.captureTimeoutMs ?? 20_000;
  const budget = createFrameBudget(framesPerSecond, now);
  const mapFrames = new Map<string, MapFrame>();
  const failures = new Map<string, { count: number; until: number }>();
  const inFlight = new Set<string>();
  const closing = new AbortController();
  let machines = new Map<string, FrameMachine>();
  let listedAt = -Infinity;
  let listing: Promise<void> | null = null;
  let available = false;
  let watchedAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | null = null;
  let captures = 0;

  function refresh(): Promise<void> {
    if (listing) return listing;
    listing = (async () => {
      try {
        const listed = options.paused?.() ? null : await options.listMachines();
        available = listed !== null;
        if (listed) {
          machines = new Map(listed.map((machine) => [machine.owner, machine]));
          const boxes = new Set(listed.map((machine) => machine.boxId));
          for (const boxId of mapFrames.keys()) if (!boxes.has(boxId)) mapFrames.delete(boxId);
        }
      } catch {
        available = false;
      } finally {
        listedAt = now();
        listing = null;
      }
    })();
    return listing;
  }

  function newest(boxId: string): MapFrame | undefined {
    const own = mapFrames.get(boxId);
    const turn = options.turnFrame(boxId);
    if (turn && (!own || turn.at > own.at)) {
      return { data: turn.data, mime: turn.mime, at: turn.at, source: "turn", version: `turn-${turn.at}` };
    }
    return own;
  }

  /** When this machine's screen should next be captured for the map, or null when it must not be. */
  function dueAt(machine: FrameMachine, at: number): number | null {
    if (!RUNNING.has(machine.state) || options.held(machine.owner) || inFlight.has(machine.boxId)) return null;
    const failure = failures.get(machine.boxId);
    if (failure && at < failure.until) return null;
    const own = mapFrames.get(machine.boxId);
    const turn = options.turnFrame(machine.boxId);
    const last = Math.max(own?.at ?? -Infinity, turn?.at ?? -Infinity);
    if (last === -Infinity) return 0;
    const fed = turn !== undefined && at - turn.at < turnFeedMs;
    const interval = fed ? turnStaleMs : options.working(machine.owner) ? workingIntervalMs : idleIntervalMs;
    return last + interval;
  }

  async function capture(machine: FrameMachine): Promise<void> {
    inFlight.add(machine.boxId);
    captures += 1;
    try {
      const shot = await options.capture(machine.boxId, AbortSignal.any([closing.signal, AbortSignal.timeout(captureTimeoutMs)]));
      // The person may have taken control while the frame was on its way.
      if (options.held(machine.owner)) return;
      const at = now();
      mapFrames.set(machine.boxId, { data: shot.data, mime: shot.mime, at, source: "map", version: `map-${at}` });
      failures.delete(machine.boxId);
    } catch {
      const count = (failures.get(machine.boxId)?.count ?? 0) + 1;
      failures.set(machine.boxId, { count, until: now() + Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (count - 1)) });
    } finally {
      inFlight.delete(machine.boxId);
    }
  }

  function tick(): void {
    const at = now();
    if (at - watchedAt > watchMs || closing.signal.aborted) {
      stop();
      return;
    }
    if (options.paused?.()) return;
    if (at - listedAt >= inventoryMs) void refresh();
    const due = [...machines.values()]
      .map((machine) => ({ machine, due: dueAt(machine, at) }))
      .filter((entry): entry is { machine: FrameMachine; due: number } => entry.due !== null && entry.due <= at)
      .sort((a, b) => a.due - b.due || Number(options.working(b.machine.owner)) - Number(options.working(a.machine.owner)));
    for (const { machine } of due) {
      if (inFlight.size >= concurrency || !budget.take()) break;
      void capture(machine);
    }
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    /** A map client is looking: keep capturing for a while. Resolves once the machines have been listed at least once. */
    async watch(): Promise<void> {
      watchedAt = now();
      if (!timer && !closing.signal.aborted) {
        timer = setInterval(tick, tickMs);
        timer.unref?.();
      }
      if (listedAt === -Infinity) await refresh();
      else if (now() - listedAt >= inventoryMs) void refresh();
    },
    machine: (owner: string): FrameMachine | undefined => machines.get(owner),
    frame: (owner: string): MapFrame | undefined => {
      const machine = machines.get(owner);
      return machine ? newest(machine.boxId) : undefined;
    },
    available: () => available,
    watching: () => timer !== null,
    captures: () => captures,
    tick,
    refresh,
    close(): void {
      closing.abort();
      stop();
    },
  };
}

export type ComputerFrames = ReturnType<typeof createComputerFrames>;
