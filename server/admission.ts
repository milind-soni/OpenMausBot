// Purity is the contract: no IO, no store reads, no adapter calls. Callers gather state, call admit(), and apply the decision.

export type AdmissionSurface =
  | "direct-busy" // 1:1 send to a thread whose turn is live: steer-first
  | "direct" // 1:1 send on a settled thread: start now or park
  | "room" // room send while the channel works: always queue
  | "room-steer" // manual steer of a queued room message: head only
  | "guarded" // guarded external send: refuse when anything is busy
  | "unattended" // routines/webhooks: busy means a missed run
  | "peer" // delegations and resume drains: slot-aware admission
  | "opened-thread" // a bot's self-opened thread: queue behind a slot
  | "incident"; // a report to the Chief's incidents thread: never refused

export type AdmissionQueueReason = "capacity" | "group-turn";

export type AdmissionRefusalCode = "guarded_busy" | "queue-head-only" | "busy" | "missing";

export const DRAIN_COALESCE_WINDOW_MS = 120_000;

/** Room turns read only the room-context window's last N messages, so a bigger group would append lines the responder never sees. */
export const DRAIN_COALESCE_MAX_ITEMS = 30;

/** The first item always drains, so an empty identity never strands a queue. */
export function drainCoalesceHead<T>(
  items: readonly T[],
  identityOf: (item: T) => string,
  queuedAtOf: (item: T) => number,
  maxItems?: number,
): T[] {
  const head: T[] = [];
  let previousIdentity: string | undefined;
  let previousAt: number | undefined;
  for (const item of items) {
    if (maxItems !== undefined && head.length >= maxItems) break;
    const identity = identityOf(item);
    const at = queuedAtOf(item);
    const gap = at - (previousAt ?? at);
    if (head.length === 0 || (identity === previousIdentity && gap >= 0 && gap <= DRAIN_COALESCE_WINDOW_MS)) {
      head.push(item);
    } else {
      break;
    }
    previousIdentity = identity;
    previousAt = at;
  }
  return head;
}

export interface AdmissionMessage {
  carriesImages?: boolean;
  engineCanSteerImages?: boolean;
  /** Steering into a turn waiting on a person's surface choice would race the choice. */
  pendingComputerSelection?: boolean;
  engineCanSteer?: boolean;
  /** Room queues drain one item per turn, so only the head may jump into the live speaker's turn. */
  isQueueHead?: boolean;
  speakerPresent?: boolean;
}

export interface AdmissionState {
  botPresent?: boolean;
  /** Broader than threadBusy: guarded sends refuse on it, ordinary sends do not. */
  botBusy?: boolean;
  threadBusy?: boolean;
  atCapacity?: boolean;
  groupTurn?: boolean;
  parksBehindCoordination?: boolean;
  roomWorking?: boolean;
  threadWorking?: boolean;
}

export type AdmissionSteerBlock = "images";

export type AdmissionDecision =
  | { action: "steer" }
  | { action: "queue"; reason?: AdmissionQueueReason; blockedBy?: AdmissionSteerBlock }
  | { action: "start" }
  | { action: "refuse"; code: AdmissionRefusalCode };

function imagesBlockSteer(message: AdmissionMessage): boolean {
  return message.carriesImages === true && message.engineCanSteerImages !== true;
}

/** Whether a live room turn holds this work back. A person's own send (sent now, or queued earlier) waits only for a
 * room turn on its own thread; every other kind of work waits for any room turn of the bot. */
export function roomTurnHolds(roomTurn: { threadId: string } | null | undefined, threadId: string, personSend: boolean): boolean {
  return Boolean(roomTurn) && (!personSend || roomTurn!.threadId === threadId);
}

export function admit(
  surface: AdmissionSurface,
  message: AdmissionMessage = {},
  state: AdmissionState = {},
): AdmissionDecision {
  switch (surface) {
    case "direct-busy": {
      if (message.engineCanSteer !== true || message.pendingComputerSelection) return { action: "queue" };
      if (imagesBlockSteer(message)) return { action: "queue", blockedBy: "images" };
      return { action: "steer" };
    }
    case "direct": {
      // groupTurn here is roomTurnHolds(): a room turn on another thread does not hold a person's own thread.
      if (state.atCapacity || state.threadBusy || state.groupTurn || state.parksBehindCoordination) {
        // Capacity outranks a room turn in the receipt because the person can fix it.
        const reason = state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined;
        return { action: "queue", reason };
      }
      return { action: "start" };
    }
    case "room":
      return (state.threadWorking ?? state.roomWorking) ? { action: "queue" } : { action: "start" };
    case "room-steer": {
      if (!message.speakerPresent || message.engineCanSteer !== true) {
        return { action: "queue" };
      }
      if (imagesBlockSteer(message)) return { action: "queue", blockedBy: "images" };
      if (!message.isQueueHead) {
        return { action: "refuse", code: "queue-head-only" };
      }
      return { action: "steer" };
    }
    case "guarded": {
      // A guarded send is an external contract: never queued, never steered, never started under stale permissions.
      if (state.botBusy || state.threadBusy || state.atCapacity || state.parksBehindCoordination || state.groupTurn) {
        return { action: "refuse", code: "guarded_busy" };
      }
      return { action: "start" };
    }
    case "unattended": {
      if (state.botPresent === false) return { action: "refuse", code: "missing" };
      if (state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "peer": {
      if (state.threadBusy || state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "opened-thread": {
      if (state.atCapacity || state.groupTurn) {
        return { action: "queue", reason: state.atCapacity ? "capacity" : "group-turn" };
      }
      return { action: "start" };
    }
    case "incident": {
      // Never refused (a refused report is a lost one), never parked behind handed-on work, never steered.
      if (state.atCapacity || state.threadBusy || state.groupTurn) {
        return { action: "queue", reason: state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined };
      }
      return { action: "start" };
    }
  }
}
