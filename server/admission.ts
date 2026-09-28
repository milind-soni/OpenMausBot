// One admission decision for every surface that starts, steers, or parks
// work. Each seam used to hand-roll its own busy policy; they agreed by
// convention and drifted by accident. This module is the frozen record of
// what each surface does today (M1): same inputs, same outputs, one place.
//
// Purity is the contract: no IO, no store reads, no adapter calls. Callers
// gather state, call admit(), and apply the returned decision with their own
// side effects. Anything that can settle a turn (an awaited steer, a slow
// disk) belongs to the caller, which re-reads state and asks again.

/** Which seam is asking. The surface fixes the policy; the state only feeds
 * it. Surfaces are deliberately distinct even where policies currently
 * coincide, so a later divergence is a one-surface change, and the golden
 * tests notice it the day it happens. */
export type AdmissionSurface =
  | "direct-busy" // 1:1 send to a thread whose turn is live: steer-first
  | "direct" // 1:1 send on a settled thread: start now or park
  | "room" // room send while the channel works: always queue
  | "room-steer" // manual steer of a queued room message: head only
  | "guarded" // guarded external send: refuse when anything is busy
  | "unattended" // routines/webhooks: busy means a missed run
  | "peer" // delegations and resume drains: slot-aware admission
  | "opened-thread"; // a bot's self-opened thread: queue behind a slot

/** The 1:1 queue's reason vocabulary, shared by the receipt, the chip, and
 * the position lookup. A reasonless park is a busy-thread correction. */
export type AdmissionQueueReason = "capacity" | "group-turn";

/** Refusal codes that callers surface verbatim. */
export type AdmissionRefusalCode = "guarded_busy" | "queue-head-only" | "busy" | "missing";

// ── L2: ordering and batching on drain ─────────────────────────────────
// M2's drain rule: a sender's CONTIGUOUS burst inside a short window is one
// item; senders never merge, and a pause past the window reads as separate
// messages. The window is measured between consecutive queued items, so a
// rolling burst stays whole while hours-apart texts split.

/** How late one queued text may follow the previous one and still join the
 * same drained turn. Two minutes covers a person typing a burst in pieces;
 * anything slower is already a separate thought, not a continuation. */
export const DRAIN_COALESCE_WINDOW_MS = 120_000;

/** The most items one drained head group may carry. Room turns read the
 * transcript through the room-context window (its last N messages), so a
 * group larger than that window would append lines the responder never
 * sees; the excess stays queued and drains with the next turn instead.
 * The 1:1 drain carries every group item in its prompt directly, so it
 * passes no cap. */
export const DRAIN_COALESCE_MAX_ITEMS = 30;

/** The leading run of queued items that drain together: consecutive items
 * with the same merge identity, each arriving within the coalescing window
 * of the one before it. Pure and shape-agnostic — each queue supplies its
 * own identity (sender + provenance kind) and timestamp accessors, and the
 * first item always drains, so an empty identity never strands a queue.
 * `maxItems`, when given, stops the group before it outgrows a bound the
 * consuming turn can actually carry. */
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
    // The gap must be non-negative AND inside the window: a regressed
    // timestamp (clock skew, a rewritten row) is not "within the window".
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

/** Facts about the message and the engine it would run on. */
export interface AdmissionMessage {
  /** extractTurnImages() found attachments: a live text steer has no image
   * side channel, so the words wait for a real turn where central image
   * admission can hand them to the provider natively. */
  carriesImages?: boolean;
  /** A computer-selection is pending on the target thread: steering new
   * words into a turn that is waiting on a person's surface choice would
   * race the choice. */
  pendingComputerSelection?: boolean;
  /** The running engine can steer: capabilities.queueing and a steer()
   * method. Engines without them keep their queue. */
  engineCanSteer?: boolean;
  /** The item being steered is the queue head. Room queues drain one item
   * per turn, so only the head may jump into the live speaker's turn. */
  isQueueHead?: boolean;
  /** A live speaker exists to steer into (rooms resolve the engine that owns
   * the running turn, exactly like the room's own Stop). */
  speakerPresent?: boolean;
}

/** Facts about the bot, thread, and room the message would land on. All
 * fields are optional booleans: the surface decides which matter. */
export interface AdmissionState {
  /** The bot record exists (routines and webhooks dispatch to a bot that
   * may have been deleted since the schedule was written). */
  botPresent?: boolean;
  /** The projected bot is busy: any thread working, waiting on a person,
   * or with no signal. Broader than threadBusy; guarded sends refuse on
   * it, ordinary sends do not. */
  botBusy?: boolean;
  /** The target thread itself is working or dispatch-claimed. */
  threadBusy?: boolean;
  /** The bot is at its parallel-thread limit. */
  atCapacity?: boolean;
  /** A room/group turn is holding the bot. It blocks direct starts without
   * consuming a capacity slot. */
  groupTurn?: boolean;
  /** #1194 opt-in: this bot's person chose to park messages behind
   * outstanding coordination assignments instead of steering. */
  parksBehindCoordination?: boolean;
  /** The room is mid-turn (its sends always queue; they never steer). */
  roomWorking?: boolean;
}

export type AdmissionDecision =
  | { action: "steer" }
  | { action: "queue"; reason?: AdmissionQueueReason }
  | { action: "start" }
  | { action: "refuse"; code: AdmissionRefusalCode };

/** The shared admission decision. Pure: same surface, message, and state
 * always return the same decision, with no side effects. */
export function admit(
  surface: AdmissionSurface,
  message: AdmissionMessage = {},
  state: AdmissionState = {},
): AdmissionDecision {
  switch (surface) {
    case "direct-busy": {
      // Steer-first for plain text into a capable engine; every mechanical
      // clamp (attachments, a pending surface choice, an incapable engine)
      // parks the words for the next ordinary turn instead.
      const steerable = !message.carriesImages && !message.pendingComputerSelection && message.engineCanSteer === true;
      return steerable ? { action: "steer" } : { action: "queue" };
    }
    case "direct": {
      if (state.atCapacity || state.threadBusy || state.groupTurn || state.parksBehindCoordination) {
        // Capacity outranks a room turn in the receipt because the person
        // can fix it (finish a thread); coordination parking is reasonless.
        const reason = state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined;
        return { action: "queue", reason };
      }
      return { action: "start" };
    }
    case "room":
      // Room sends never auto-steer; the queue is the policy. Human override
      // is the head-only manual steer below.
      return state.roomWorking ? { action: "queue" } : { action: "start" };
    case "room-steer": {
      if (!message.speakerPresent || message.engineCanSteer !== true) {
        // An incapable room keeps its queue, exactly like an incapable 1:1
        // engine; the request succeeds without delivering.
        return { action: "queue" };
      }
      if (!message.isQueueHead) {
        return { action: "refuse", code: "queue-head-only" };
      }
      return { action: "steer" };
    }
    case "guarded": {
      // A guarded send is an external contract: never queued, never steered,
      // never started under stale permissions. Any busy shape refuses.
      if (state.botBusy || state.threadBusy || state.atCapacity || state.parksBehindCoordination || state.groupTurn) {
        return { action: "refuse", code: "guarded_busy" };
      }
      return { action: "start" };
    }
    case "unattended": {
      // Routines and webhooks share startTurn's admission; busy means a
      // missed or failed run, not a queue — their receipts are the
      // monitoring feature.
      if (state.botPresent === false) return { action: "refuse", code: "missing" };
      if (state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "peer": {
      // Exactly what startTurn admits for a direct thread: the landing
      // thread free, a free slot, no live room turn. Never the whole-bot
      // busy flag.
      if (state.threadBusy || state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "opened-thread": {
      // A self-opened thread is brand new: its own busy flag is impossible,
      // so only a full slot list or a live room turn can park it. Provenance
      // (peerAsk, unattended) survives the wait in the queue payload.
      if (state.atCapacity || state.groupTurn) {
        return { action: "queue", reason: state.atCapacity ? "capacity" : "group-turn" };
      }
      return { action: "start" };
    }
  }
}
