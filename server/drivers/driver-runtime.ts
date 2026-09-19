import type { ModelCatalog, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { newEventId } from "../contracts.ts";

/** What the runtime needs from a driver's per-turn bookkeeping. Drivers keep
 *  their own handles on the entry (abort controllers, ask maps, child
 *  processes); `turnId` is the one field every active turn carries. */
export interface DriverActiveTurn {
  turnId: string;
}

/** The identity fields every RuntimeEvent starts from. */
export interface DriverEventBase {
  eventId: string;
  provider: string;
  providerInstanceId?: string;
  threadId: string;
  turnId: string;
  createdAt: string;
}

interface DriverSessionRuntimeOptions<Turn extends DriverActiveTurn> {
  /** The provider stamp on every event base (`DRIVER_KIND`). */
  driverKind: string;
  /** The instance stamp on every event base when the driver includes one. */
  providerInstanceId?: string;
  /** Stop one running turn — the shared body of stopAll() and dispose().
   *  Return a promise only when the driver's contract waits for the turn to
   *  settle; a rejection never escapes stopAll()/dispose(). */
  stopTurn(turn: Turn): void | Promise<void>;
  /** Runs after every running turn was stopped, with the operation that
   *  triggered the teardown — a driver's hook for resources no running turn
   *  owns (idle sessions). Like stopTurn, a rejection never escapes
   *  stopAll()/dispose(). */
  afterStopTurns?(source: "stopAll" | "dispose"): void | Promise<void>;
}

export interface DriverSessionRuntime<Turn extends DriverActiveTurn> {
  /** Deliver an event to every listener registered when emit began. */
  emit(event: RuntimeEvent): void;
  /** Fresh identity fields for one event on a thread's turn. */
  base(threadId: string, turnId: string): DriverEventBase;
  /** The busy guard: throw when a turn is already running on the thread.
   *  `allowBusy` covers a driver-internal takeover that keeps the logical
   *  turn's entry registered while it relaunches (claude's retry path) — the
   *  runtime itself never special-cases one. */
  assertThreadIdle(threadId: string, options?: { allowBusy?: boolean }): void;
  /** Register the running turn a sendTurn claimed the thread for. */
  setTurn(threadId: string, turn: Turn): void;
  /** Release the thread when the turn settles. */
  endTurn(threadId: string): void;
  /** The running turn on a thread, if any. */
  turn(threadId: string): Turn | undefined;
  /** The adapter's hasSession. */
  hasSession(threadId: string): boolean;
  /** The adapter's onEvent: register a listener, get its unsubscribe. */
  onEvent(listener: RuntimeEventListener): () => void;
  /** The adapter's stopAll: stop every running turn. */
  stopAll(): Promise<void>;
  /** The instance's dispose: stop every turn, then drop the listeners. */
  dispose(): Promise<void>;
}

/** Shared session runtime for provider drivers. Six drivers (claude, codex,
 *  the ACP core, openai-chat, pi, boxagent) hand-rolled the same skeleton —
 *  listener set, one-active-turn-per-thread map, busy guard, event base
 *  factory, stopAll/dispose — and drifted while doing it. It lives here once
 *  so a fix to any part lands for every driver at the same time. */
export function createDriverSessionRuntime<Turn extends DriverActiveTurn>(
  options: DriverSessionRuntimeOptions<Turn>,
): DriverSessionRuntime<Turn> {
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, Turn>();

  // Snapshot before delivering: a listener that unsubscribes (or registers)
  // from inside another listener must not change what this emit reaches.
  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    ...(options.providerInstanceId !== undefined ? { providerInstanceId: options.providerInstanceId } : {}),
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });
  const assertThreadIdle = (threadId: string, claim?: { allowBusy?: boolean }) => {
    if (active.has(threadId) && !claim?.allowBusy) throw new Error("a turn is already running on this thread");
  };
  const setTurn = (threadId: string, turn: Turn) => {
    active.set(threadId, turn);
  };
  const endTurn = (threadId: string) => {
    active.delete(threadId);
  };
  const turn = (threadId: string) => active.get(threadId);
  const hasSession = (threadId: string) => active.has(threadId);
  const onEvent = (listener: RuntimeEventListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const stopTurns = async (source: "stopAll" | "dispose") => {
    // Snapshot: stopping one turn can settle (and remove) the others.
    const turns = Array.from(active.values());
    await Promise.all(turns.map((activeTurn) => Promise.resolve(options.stopTurn(activeTurn)).catch(() => {})));
    await Promise.resolve(options.afterStopTurns?.(source)).catch(() => {});
  };
  const stopAll = () => stopTurns("stopAll");
  const dispose = async () => {
    await stopTurns("dispose");
    listeners.clear();
  };

  return { emit, base, assertThreadIdle, setTurn, endTurn, turn, hasSession, onEvent, stopAll, dispose };
}

/** The mutable model catalog every driver instance serves: a static list
 *  until discovery replaces it, and the Refresh action that re-runs
 *  discovery. claude, codex, and the ACP core hand-rolled the same closure
 *  (keep the last usable catalog when discovery fails or comes back empty)
 *  and drifted while doing it. */
export interface DriverModelCatalog<Models extends ModelCatalog = ModelCatalog> {
  /** The catalog to serve; a refresh replaces it only when discovery
   *  returned at least one option. */
  readonly models: Models;
  /** Re-run catalog discovery; keeps the last usable catalog on failure. */
  readonly refreshModels: () => Promise<void>;
}

/** Build the shared refreshModels shape. The provider-specific catalog
 *  fetching stays in each driver: `load` is exactly what the driver's old
 *  closure ran inside its try block. */
export function createRefreshModels<Models extends ModelCatalog>(options: {
  /** The static catalog to serve until discovery returns one. */
  initial: Models;
  /** Provider-specific discovery. Omit it when the engine has no live
   *  source (managed catalogs); a nullish or empty result keeps the
   *  current catalog. */
  load?: () => Models | undefined | null | Promise<Models | undefined | null>;
}): DriverModelCatalog<Models> {
  let models = options.initial;
  const refreshModels = async () => {
    if (!options.load) return;
    try {
      const resolved = await options.load();
      if (resolved && resolved.options.length) models = resolved;
    } catch {
      // Keep the last usable catalog when discovery fails.
    }
  };
  return { get models() { return models; }, refreshModels };
}
