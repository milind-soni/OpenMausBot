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
  stopTurn(turn: Turn): void | Promise<unknown>;
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
  /** The atomic busy guard: reserve the thread for `turnId` in the same
   *  operation, before sendTurn's first await, so concurrent same-thread
   *  calls cannot both pass. setTurn completes the reservation; endTurn
   *  releases it when setup fails before a Turn exists. */
  claimTurn(threadId: string, turnId: string): void;
  /** Whether a teardown canceled this claim: a launch that set up while
   *  stopAll()/dispose() ran must not dispatch or register work after it. */
  claimCanceled(turnId: string): boolean;
  /** Register the running turn a sendTurn claimed the thread for. */
  setTurn(threadId: string, turn: Turn): void;
  /** Release the thread when the turn settles. With `turnId`, release only
   *  the entry that turn owns — a stale settlement must not delete a newer
   *  turn's registration. */
  endTurn(threadId: string, turnId?: string): void;
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
  // Reservations claimTurn made: threadId → turnId, held from before a
  // sendTurn's first await until setTurn registers the finished Turn (or
  // endTurn releases a setup that failed before then).
  const claims = new Map<string, string>();
  // Turn ids whose claims a teardown canceled: a start that settles after
  // stopAll()/dispose() must not register — or run — as new work.
  const canceledClaims = new Set<string>();
  // Set by dispose(): no new claim or registration may follow it.
  let disposed = false;
  // Set while stopAll()/dispose() runs: claimTurn rejects for the whole
  // teardown, so a start cannot slip past the claim snapshot and register
  // work a teardown already finished.
  let stopping = false;

  // Snapshot before delivering: a listener that unsubscribes (or registers)
  // from inside another listener must not change what this emit reaches.
  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        console.error("driver event listener failed", error);
      }
    }
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    ...(options.providerInstanceId !== undefined ? { providerInstanceId: options.providerInstanceId } : {}),
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });
  const busy = (threadId: string) => active.has(threadId) || claims.has(threadId);
  const assertThreadIdle = (threadId: string, claim?: { allowBusy?: boolean }) => {
    if (busy(threadId) && !claim?.allowBusy) throw new Error("a turn is already running on this thread");
  };
  const claimTurn = (threadId: string, turnId: string) => {
    if (disposed) throw new Error("the driver runtime was disposed");
    if (stopping) throw new Error("the driver runtime is stopping its turns");
    if (busy(threadId)) throw new Error("a turn is already running on this thread");
    canceledClaims.delete(turnId);
    claims.set(threadId, turnId);
  };
  const setTurn = (threadId: string, turn: Turn) => {
    // A start whose claim a teardown canceled (or that settled after dispose)
    // registers nothing: stop the work it created and leave the thread idle.
    if (canceledClaims.delete(turn.turnId) || disposed) {
      void Promise.resolve().then(() => options.stopTurn(turn)).catch(() => {});
      return;
    }
    claims.delete(threadId);
    active.set(threadId, turn);
  };
  const endTurn = (threadId: string, turnId?: string) => {
    if (turnId === undefined || active.get(threadId)?.turnId === turnId) active.delete(threadId);
    if (turnId === undefined || claims.get(threadId) === turnId) claims.delete(threadId);
    if (turnId !== undefined) canceledClaims.delete(turnId);
  };
  const claimCanceled = (turnId: string) => canceledClaims.has(turnId);
  const turn = (threadId: string) => active.get(threadId);
  const hasSession = (threadId: string) => active.has(threadId);
  const onEvent = (listener: RuntimeEventListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  // Overlapping stopAll()/dispose() calls serialize behind one chain: a
  // concurrent second teardown would snapshot and stop the same turns twice,
  // and the first finisher would reopen claimTurn() while teardown still
  // drains. `stopping` closes claims until the last queued teardown ends.
  let stopTurnsChain: Promise<void> = Promise.resolve();
  let stopTurnsQueued = 0;
  // Turns this teardown chain already stopped. A stopTurn that returns void
  // (a fire-and-forget cancel, like boxagent's) leaves its entry registered
  // until the turn settles on its own, so a queued teardown that snapshots
  // afresh must skip it - stopping it again would call the driver's cancel
  // twice for one turn. The set clears when the chain drains and new turns
  // may claim threads again.
  const stoppedTurns = new Set<Turn>();
  const stopTurns = (source: "stopAll" | "dispose") => {
    stopping = true;
    stopTurnsQueued += 1;
    const run = stopTurnsChain.then(async () => {
      try {
        // Snapshot: stopping one turn can settle (and remove) the others.
        const turns = Array.from(active.values()).filter((activeTurn) => !stoppedTurns.has(activeTurn));
        for (const activeTurn of turns) stoppedTurns.add(activeTurn);
        // Claimed starts have no Turn to stop yet: cancel their reservations so
        // the sendTurn holding one stops — and registers nothing — when it settles.
        for (const turnId of claims.values()) canceledClaims.add(turnId);
        claims.clear();
        if (source === "dispose") disposed = true;
        await Promise.all(turns.map((activeTurn) => Promise.resolve().then(() => options.stopTurn(activeTurn)).catch(() => {})));
        await Promise.resolve().then(() => options.afterStopTurns?.(source)).catch(() => {});
      } finally {
        stopTurnsQueued -= 1;
        if (stopTurnsQueued === 0) {
          stopping = false;
          stoppedTurns.clear();
        }
      }
    });
    stopTurnsChain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const stopAll = () => stopTurns("stopAll");
  const dispose = async () => {
    await stopTurns("dispose");
    listeners.clear();
  };

  return { emit, base, assertThreadIdle, claimTurn, claimCanceled, setTurn, endTurn, turn, hasSession, onEvent, stopAll, dispose };
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
  // Refreshes can overlap (create-time discovery and the Refresh action); a
  // slower, older load resolving late must not overwrite a newer catalog.
  let refreshGeneration = 0;
  let appliedGeneration = 0;
  const refreshModels = async () => {
    if (!options.load) return;
    const generation = ++refreshGeneration;
    try {
      const resolved = await options.load();
      if (resolved && resolved.options.length && generation > appliedGeneration) {
        models = resolved;
        appliedGeneration = generation;
      }
    } catch {
      // Keep the last usable catalog when discovery fails.
    }
  };
  return { get models() { return models; }, refreshModels };
}
