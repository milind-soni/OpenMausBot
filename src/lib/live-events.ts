// EventSource hides SSE comment keepalives, so liveness comes from the server's visible `ping` frame.
import type { ServerFrame } from "../../shared/wire";
import { cloudAsleep, markCloudAsleep, onCloudPower, sleepingFrame } from "./cloud-power";
import { recordBotTextMessage, recordRuntimeEvent } from "./voice-latency-probe";
import { noteTurnEvent } from "@/state/turn-status";

export const LIVE_EVENTS_PATH = "/api/events";
export const LIVE_EVENTS_STALE_MS = 40_000;
export const LIVE_EVENTS_RETRY_MIN_MS = 500;
export const LIVE_EVENTS_RETRY_MAX_MS = 10_000;
const RETRY_LIVE_EVENTS = "omb:retry-live-events";

export function retryLiveEvents(): void {
  window.dispatchEvent(new Event(RETRY_LIVE_EVENTS));
}

export interface LiveFrame {
  kind: string;
  cursor?: string;
  resumed?: boolean;
  event?: unknown;
}

interface LiveMessageEvent {
  data: string;
  lastEventId?: string;
}

export interface LiveEventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: LiveMessageEvent) => void) | null;
  close: () => void;
}

interface ListenerTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface LiveEventsPlatform {
  createEventSource: (url: string) => LiveEventSourceLike;
  windowTarget?: ListenerTarget;
  documentTarget?: ListenerTarget;
  isVisible: () => boolean;
  isOnline: () => boolean;
  now: () => number;
}

export interface LiveEventsHandlers {
  onFrame: (frame: LiveFrame) => void;
  /** The transport commits the new cursor only after this resolves true. */
  onSnapshotRequired: () => Promise<boolean>;
  onOpen?: () => void;
  onError?: () => void;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

/** `screens: false` asks the server to leave out live screen frames. */
export function liveEventsUrl(options?: { since?: string | null; screens?: boolean }): string {
  const params = new URLSearchParams();
  if (options?.since) params.set("since", options.since);
  if (options?.screens === false) params.set("screens", "off");
  const query = params.toString();
  return query ? `${LIVE_EVENTS_PATH}?${query}` : LIVE_EVENTS_PATH;
}

export interface LiveFrameListener {
  onFrame: (frame: ServerFrame) => void;
  onMissedFrames?: () => void;
  /** Draws live screens: while a listener with this is registered the stream carries screen frames; with none it does not. */
  screens?: boolean;
}

const liveFrameListeners = new Set<LiveFrameListener>();
const screenWishListeners = new Set<() => void>();
const screensWanted = () => [...liveFrameListeners].some((listener) => listener.screens);

export function listenLiveFrames(listener: LiveFrameListener): () => void {
  const before = screensWanted();
  liveFrameListeners.add(listener);
  if (screensWanted() !== before) for (const changed of screenWishListeners) changed();
  return () => {
    const wanted = screensWanted();
    liveFrameListeners.delete(listener);
    if (screensWanted() !== wanted) for (const changed of screenWishListeners) changed();
  };
}

/** A frame kept for later (before the first snapshot is drawn) needs no pixels: viewers saw them as it arrived. */
export function withoutScreenPixels(frame: ServerFrame): ServerFrame {
  if (frame.kind !== "screen") return frame;
  const { png: _png, ...rest } = frame;
  return { ...rest, png: "" };
}

export function publishLiveFrame(frame: ServerFrame): void {
  for (const listener of liveFrameListeners) listener.onFrame(frame);
}

export function publishMissedFrames(): void {
  for (const listener of liveFrameListeners) listener.onMissedFrames?.();
}

export function isLivePing(frame: Pick<LiveFrame, "kind">): boolean {
  return frame.kind === "ping";
}

export function shouldReconnectLiveEvents(
  lastHeardAt: number,
  now: number,
  staleMs = LIVE_EVENTS_STALE_MS,
): boolean {
  return now - lastHeardAt >= staleMs;
}

function parseLiveFrame(data: string): LiveFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || Array.isArray(value) || Object(value) !== value) return null;
  const candidate = value as {
    kind?: unknown;
    cursor?: unknown;
    resumed?: unknown;
    event?: unknown;
  };
  if (candidate.kind !== String(candidate.kind)) return null;
  if (candidate.cursor !== undefined && candidate.cursor !== String(candidate.cursor)) return null;
  if (candidate.resumed !== undefined && candidate.resumed !== Boolean(candidate.resumed)) return null;
  return candidate as LiveFrame;
}

function tapLiveFrame(frame: ServerFrame): void {
  if (frame.kind === "runtime") {
    // The chat's status line reads every live runtime frame; none of them is stored.
    noteTurnEvent(frame.event);
    recordRuntimeEvent(frame.event);
  } else if (frame.kind === "message" && frame.message?.role === "bot" && frame.message?.kind === "text") {
    recordBotTextMessage(frame.message, frame.threadId);
  }
}

function browserPlatform(overrides: Partial<LiveEventsPlatform>): LiveEventsPlatform | null {
  const NativeEventSource = globalThis.EventSource;
  const createEventSource =
    overrides.createEventSource ??
    (!NativeEventSource
      ? undefined
      : (url: string) => {
          const native = new NativeEventSource(url);
          const adapter: LiveEventSourceLike = {
            onopen: null,
            onerror: null,
            onmessage: null,
            close: () => native.close(),
          };
          native.onopen = () => adapter.onopen?.();
          native.onerror = () => adapter.onerror?.();
          native.onmessage = (event) => adapter.onmessage?.(event);
          return adapter;
        });
  if (!createEventSource) return null;

  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  return {
    createEventSource,
    windowTarget:
      overrides.windowTarget ??
      (browserWindow
        ? {
            addEventListener: (type, listener) => browserWindow.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserWindow.removeEventListener(type, listener),
          }
        : undefined),
    documentTarget:
      overrides.documentTarget ??
      (browserDocument
        ? {
            addEventListener: (type, listener) => browserDocument.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserDocument.removeEventListener(type, listener),
          }
        : undefined),
    isVisible:
      overrides.isVisible ?? (() => !browserDocument || browserDocument.visibilityState === "visible"),
    isOnline: overrides.isOnline ?? (() => globalThis.navigator?.onLine !== false),
    now: overrides.now ?? Date.now,
  };
}

export function openLiveEvents(
  handlers: LiveEventsHandlers,
  platformOverrides: Partial<LiveEventsPlatform> = {},
): () => void {
  const platform = browserPlatform(platformOverrides);
  if (!platform) {
    handlers.onError?.();
    return () => {};
  }

  const staleMs = handlers.staleMs ?? LIVE_EVENTS_STALE_MS;
  const retryMinMs = Math.max(1, handlers.retryMinMs ?? LIVE_EVENTS_RETRY_MIN_MS);
  const retryMaxMs = Math.max(retryMinMs, handlers.retryMaxMs ?? LIVE_EVENTS_RETRY_MAX_MS);
  const staleCheckMs = Math.min(10_000, Math.max(250, staleMs / 2));

  let stopped = false;
  let source: LiveEventSourceLike | null = null;
  let sourceScreens = screensWanted();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let cursor: string | null = null;
  let lastHeardAt = platform.now();
  let snapshotGeneration = 0;
  let pendingSnapshot: {
    generation: number;
    source: LiveEventSourceLike;
    boundaryCursor: string | null;
    newestFrameCursor: string | null;
  } | null = null;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const closeSource = () => {
    const current = source;
    source = null;
    if (!current) return;
    if (pendingSnapshot?.source === current) {
      snapshotGeneration += 1;
      pendingSnapshot = null;
    }
    current.onopen = null;
    current.onerror = null;
    current.onmessage = null;
    current.close();
  };

  let connect: () => void;
  const scheduleReconnect = () => {
    // A Cloud home that went to sleep: reconnecting would wake it. The person's next action does (src/lib/cloud-power.ts).
    if (stopped || retryTimer !== null || !platform.isOnline() || !platform.isVisible() || cloudAsleep()) return;
    const exponent = Math.min(retryAttempt, 20);
    const delay = Math.min(retryMaxMs, retryMinMs * 2 ** exponent);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!platform.isVisible()) return;
      connect();
    }, delay);
  };

  const connectionLost = (current: LiveEventSourceLike) => {
    if (stopped || source !== current) return;
    closeSource();
    handlers.onError?.();
    scheduleReconnect();
  };

  connect = () => {
    if (stopped || source || !platform.isOnline() || cloudAsleep()) return;
    let current: LiveEventSourceLike;
    try {
      sourceScreens = screensWanted();
      current = platform.createEventSource(liveEventsUrl({ since: cursor, screens: sourceScreens }));
    } catch {
      handlers.onError?.();
      scheduleReconnect();
      return;
    }

    source = current;
    lastHeardAt = platform.now();
    current.onopen = () => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();
      handlers.onOpen?.();
    };
    current.onerror = () => connectionLost(current);
    current.onmessage = (event) => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();

      const frame = parseLiveFrame(event.data);
      if (!frame) return;

      if (isLivePing(frame)) {
        // An open event only proves a handshake; a ping proves the stream stayed usable.
        retryAttempt = 0;
        return;
      }

      if (frame.kind === "hello") {
        // Replay frames follow `resumed:true`: advancing to hello's cursor now could skip one if the socket dies mid-replay.
        if (frame.resumed === false) {
          const generation = ++snapshotGeneration;
          pendingSnapshot = {
            generation,
            source: current,
            boundaryCursor: frame.cursor || null,
            newestFrameCursor: null,
          };
          void (async () => {
            let loaded = false;
            try {
              loaded = await handlers.onSnapshotRequired();
            } catch {
              loaded = false;
            }
            const pending = pendingSnapshot;
            if (
              stopped ||
              source !== current ||
              !pending ||
              pending.generation !== generation
            ) {
              return;
            }
            if (!loaded) {
              pendingSnapshot = null;
              connectionLost(current);
              return;
            }
            cursor = pending.newestFrameCursor ?? pending.boundaryCursor;
            pendingSnapshot = null;
            onScreenWish();
          })();
        }
      } else if (event.lastEventId) {
        if (pendingSnapshot?.source === current) {
          pendingSnapshot.newestFrameCursor = event.lastEventId;
        } else {
          cursor = event.lastEventId;
        }
      }

      if (sleepingFrame(frame as LiveFrame & { state?: unknown })) {
        // The home agreed to sleep: close quietly (not a lost connection) and stay closed until the person is back. The
        // cursor is past this frame by now, so waking never resumes before it: a Cloud that replays it would close us again.
        clearRetry();
        closeSource();
        markCloudAsleep();
        return;
      }

      if (frame.kind !== "hello") {
        tapLiveFrame(frame as ServerFrame);
        handlers.onFrame(frame);
      }
    };
  };

  const reconnectNow = (reportDisconnect: boolean) => {
    if (stopped || !platform.isOnline()) return;
    clearRetry();
    if (source) {
      closeSource();
      if (reportDisconnect) handlers.onError?.();
    }
    connect();
  };

  const recover = () => {
    // Background tabs suspend timers and network delivery: recover once on wake.
    if (stopped || !platform.isOnline() || !platform.isVisible() || cloudAsleep()) return;
    if (!source || shouldReconnectLiveEvents(lastHeardAt, platform.now(), staleMs)) {
      reconnectNow(source !== null);
    }
  };
  const onOnline = () => recover();
  const onFocus = () => {
    if (platform.isVisible()) recover();
  };
  const onVisibilityChange = () => {
    if (platform.isVisible()) recover();
  };
  const onRetry = () => {
    if (platform.isVisible() && !cloudAsleep()) reconnectNow(true);
  };

  const onScreenWish = () => queueMicrotask(() => {
    if (source && cursor && !pendingSnapshot && screensWanted() !== sourceScreens) reconnectNow(false);
  });
  screenWishListeners.add(onScreenWish);
  connect();
  const staleTimer = setInterval(recover, staleCheckMs);
  // The person is back after the Cloud slept: reconnect at once, which wakes it.
  const stopPower = onCloudPower((asleep) => { if (!asleep) reconnectNow(false); });
  platform.windowTarget?.addEventListener("online", onOnline);
  platform.windowTarget?.addEventListener("focus", onFocus);
  platform.windowTarget?.addEventListener(RETRY_LIVE_EVENTS, onRetry);
  platform.documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (stopped) return;
    stopped = true;
    screenWishListeners.delete(onScreenWish);
    stopPower();
    clearInterval(staleTimer);
    clearRetry();
    closeSource();
    platform.windowTarget?.removeEventListener("online", onOnline);
    platform.windowTarget?.removeEventListener("focus", onFocus);
    platform.windowTarget?.removeEventListener(RETRY_LIVE_EVENTS, onRetry);
    platform.documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
