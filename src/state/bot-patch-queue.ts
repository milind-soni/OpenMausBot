import type { Bot, BotAnnouncement } from "./store";

/** Every field written through the desktop's broad bot PATCH boundary. */
export type BotUpdatePatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "notifications"
    | "cloudBackend"
    | "autoStartVps"
    | "color"
    | "mascotExpression"
    | "avatarUrl"
    | "avatarCrop"
    | "autoApprove"
    | "approvalMode"
    | "speakReplies"
    | "voice"
    | "pinned"
    | "hidden"
    | "section"
    | "pinnedMessageId"
    | "chiefOfStaff"
    | "approvePeerComms"
    | "composio"
    | "browser"
    | "browserProfile"
    | "modelSelection"
  >
> & {
  /** null is the wire representation for clearing an explicit destination
   * and returning to Auto. Bot state itself keeps Auto as an absent field. */
  computer?: Bot["computer"] | null;
  /** Rides the PATCH body only: the server's proof that the local-auto
   * warning dialog was shown (see server/index.ts's consent gate). It must
   * reach the wire inside the coalesced body and must never fold into bot
   * state — the queue strips it from every overlay it hands back. */
  acknowledgeLocalAuto?: boolean;
  /** Renderer-local marker that the elevated-risk Full access dialog was
   * confirmed. StoreProvider consumes it before the private Electron request;
   * it is never sent over HTTP or folded into bot state. */
  confirmFullAccess?: boolean;
};

/** A wire patch after clear-only values have been normalized for Bot state. */
export type BotStatePatch = Omit<
  BotUpdatePatch,
  "computer" | "acknowledgeLocalAuto" | "confirmFullAccess"
> & {
  computer?: Bot["computer"];
};

interface BotPatchQueueEntry {
  botId: string;
  fallback: BotAnnouncement;
  pending: BotUpdatePatch;
  inFlight: BotUpdatePatch;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  controller: AbortController | null;
  cancelled: boolean;
  idleWaiters: Array<(bot: BotAnnouncement | null) => void>;
}

export interface BotPatchQueueOptions {
  delayMs?: number;
  send: (
    botId: string,
    patch: BotUpdatePatch,
    signal: AbortSignal,
    current: BotAnnouncement,
  ) => Promise<BotAnnouncement>;
  reconcile: (botId: string, signal: AbortSignal) => Promise<BotAnnouncement | null>;
  onAuthoritative: (bot: BotAnnouncement, optimisticOverlay: BotStatePatch) => void;
  onError: (error: Error) => void;
}

export interface BotPatchQueue {
  enqueue: (botId: string, patch: BotUpdatePatch, fallback: BotAnnouncement) => void;
  /** Wait for the lane to settle and return the server-authoritative bot.
   * null means there was no queued write (or the lane was cancelled). */
  flush: (botId: string) => Promise<BotAnnouncement | null>;
  overlayFor: (botId: string) => BotStatePatch;
  cancel: (botId: string) => void;
  /** Undo a dispose. Exists for React StrictMode, whose dev-mode mount probe
   * runs the effect cleanup once against the SAME memoized queue — without
   * this, dispose() would permanently disable saving in development. */
  revive: () => void;
  dispose: () => void;
}

const hasFields = (patch: BotUpdatePatch): boolean => Object.keys(patch).length > 0;
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");

/** What may fold back into renderer bot state: everything except the consent
 * flag, which is wire-only. One strip point covers both overlay paths. */
const stateOverlay = (patch: BotUpdatePatch): BotStatePatch => {
  const {
    acknowledgeLocalAuto: _localAck,
    confirmFullAccess: _fullConfirmation,
    computer,
    ...fields
  } = patch;
  if (computer === null) return { ...fields, computer: undefined };
  return computer === undefined ? fields : { ...fields, computer };
};

/**
 * A per-bot mutation lane: edits debounce together, requests never overtake
 * one another, and every response/error is folded back from an authoritative
 * server bot while preserving only edits that were made later.
 */
export function createBotPatchQueue(options: BotPatchQueueOptions): BotPatchQueue {
  const entries = new Map<string, BotPatchQueueEntry>();
  const delayMs = options.delayMs ?? 400;
  let disposed = false;

  const settleIfIdle = (entry: BotPatchQueueEntry) => {
    if (entry.running || entry.timer !== null || hasFields(entry.pending)) return;
    entries.delete(entry.botId);
    for (const resolve of entry.idleWaiters.splice(0)) resolve(entry.fallback);
  };

  const drain = async (entry: BotPatchQueueEntry): Promise<void> => {
    if (disposed || entry.running || entry.timer !== null || !hasFields(entry.pending)) return;
    entry.running = true;
    const patch = entry.pending;
    entry.pending = {};
    entry.inFlight = patch;
    const controller = new AbortController();
    entry.controller = controller;

    try {
      const bot = await options.send(entry.botId, patch, controller.signal, entry.fallback);
      if (disposed || entry.cancelled) return;
      entry.fallback = bot;
      options.onAuthoritative(bot, stateOverlay(entry.pending));
    } catch (caught) {
      if (!disposed && !entry.cancelled) {
        const supersededApproval = controller.signal.aborted &&
          hasOwn(entry.pending, "approvalMode") &&
          isAbortError(caught);
        if (supersededApproval) return;
        // A rejected patch is no longer optimistic. Re-read before rolling back
        // because a lost HTTP response may still have committed and broadcast.
        entry.inFlight = {};
        let bot: BotAnnouncement | null = entry.fallback;
        try {
          bot = await options.reconcile(entry.botId, controller.signal);
          if (bot) entry.fallback = bot;
        } catch {
          // The captured pre-edit bot is safer than leaving rejected input in
          // state when the reconciliation request is unavailable too.
        }
        // Deletion may cancel this lane while the re-read is in flight. Folding
        // that result back into state would resurrect the deleted bot.
        if (disposed || entry.cancelled) return;
        if (bot) options.onAuthoritative(bot, stateOverlay(entry.pending));
        options.onError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      entry.controller = null;
      entry.inFlight = {};
      entry.running = false;
      if (!disposed && !entry.cancelled) {
        if (hasFields(entry.pending) && entry.timer === null) void drain(entry);
        settleIfIdle(entry);
      }
    }
  };

  const schedule = (entry: BotPatchQueueEntry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void drain(entry);
    }, delayMs);
  };

  return {
    enqueue(botId, patch, fallback) {
      if (disposed || !hasFields(patch)) return;
      const entry = entries.get(botId) ?? {
        botId,
        fallback,
        pending: {},
        inFlight: {},
        timer: null,
        running: false,
        controller: null,
        cancelled: false,
        idleWaiters: [],
      };
      entries.set(botId, entry);
      entry.pending = { ...entry.pending, ...patch };
      // A private Full/Custom grant cannot be cancelled after it crosses the
      // Electron bridge. Signal the sender as soon as a newer level exists so
      // it can compensate a late grant back to Ask before this lane advances.
      const inFlightMode = entry.inFlight.approvalMode;
      if (
        entry.running &&
        (inFlightMode === "full" || inFlightMode === "custom") &&
        hasOwn(patch, "approvalMode") &&
        patch.approvalMode !== inFlightMode
      ) {
        entry.controller?.abort();
      }
      // Execution-boundary edits must start immediately. They still share the
      // same serialized lane, but never sit behind the cosmetic 400 ms
      // debounce where a message/routine could begin under stale permissions.
      const immediate = Object.prototype.hasOwnProperty.call(patch, "approvalMode") ||
        Object.prototype.hasOwnProperty.call(patch, "modelSelection");
      if (immediate) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        void drain(entry);
      } else {
        schedule(entry);
      }
    },

    flush(botId) {
      const entry = entries.get(botId);
      if (!entry) return Promise.resolve(null);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const idle = new Promise<BotAnnouncement | null>((resolve) => entry.idleWaiters.push(resolve));
      void drain(entry);
      settleIfIdle(entry);
      return idle;
    },

    overlayFor(botId) {
      const entry = entries.get(botId);
      return entry ? stateOverlay({ ...entry.inFlight, ...entry.pending }) : {};
    },

    cancel(botId) {
      const entry = entries.get(botId);
      if (!entry) return;
      entry.cancelled = true;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.controller?.abort();
      entries.delete(botId);
      for (const resolve of entry.idleWaiters.splice(0)) resolve(null);
    },

    revive() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        entry.cancelled = true;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.controller?.abort();
        for (const resolve of entry.idleWaiters.splice(0)) resolve(null);
      }
      entries.clear();
    },
  };
}
