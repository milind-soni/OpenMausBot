/**
 * Supervise one browser EventSource for `/api/events`.
 *
 * EventSource hides SSE comment keepalives, so a half-open proxy can leave the
 * UI looking connected forever. The server also sends a visible `ping` frame;
 * this supervisor uses it as liveness, owns reconnects itself, and carries an
 * explicit replay cursor whenever it replaces the native EventSource.
 */
export const LIVE_EVENTS_PATH = "/api/events";
export const LIVE_EVENTS_STALE_MS = 40_000;
export const LIVE_EVENTS_RETRY_MIN_MS = 500;
export const LIVE_EVENTS_RETRY_MAX_MS = 10_000;

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
  /** Rebuild the consumer's complete snapshot after the server says its
   * replay gap cannot be filled. The transport commits the new cursor only
   * after this succeeds; false/rejection closes the stream and retries from
   * the last known-good boundary. */
  onSnapshotRequired: () => Promise<boolean>;
  onOpen?: () => void;
  onError?: () => void;
  screens?: boolean;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

export function liveEventsUrl(options?: { since?: string | null; screens?: boolean }): string {
  const params = new URLSearchParams();
  if (options?.since) params.set("since", options.since);
  if (options?.screens === false) params.set("screens", "off");
  const query = params.toString();
  return query ? `${LIVE_EVENTS_PATH}?${query}` : LIVE_EVENTS_PATH;
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

/** Parse only the transport envelope here. Payloads remain owned by their
 * consumers; cloning every token delta through a general schema would put
 * avoidable work on the hottest renderer path. */
function parseLiveFrame(data: string): LiveFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || Array.isArray(value) || Object(value) !== value) return null;
  // SAFETY: the object guard above establishes an indexable JSON object; each
  // transport-owned field is validated below before exposing LiveFrame.
  const candidate = value as {
    kind?: unknown;
    cursor?: unknown;
    resumed?: unknown;
    event?: unknown;
  };
  if (candidate.kind !== String(candidate.kind)) return null;
  if (candidate.cursor !== undefined && candidate.cursor !== String(candidate.cursor)) return null;
  if (candidate.resumed !== undefined && candidate.resumed !== Boolean(candidate.resumed)) return null;
  // SAFETY: kind is a string and the two optional transport fields were
  // checked against their exact primitive representations above.
  return candidate as LiveFrame;
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

/**
 * Open and supervise one live stream. The returned function owns all cleanup:
 * after it runs, no EventSource, reconnect timer, or browser listener remains.
 * The optional platform is intentionally narrow so connection behavior can be
 * tested without a browser or network.
 */
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
    if (stopped || retryTimer !== null || !platform.isOnline() || !platform.isVisible()) return;
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
    if (stopped || source || !platform.isOnline()) return;
    let current: LiveEventSourceLike;
    try {
      current = platform.createEventSource(
        liveEventsUrl({ since: cursor, screens: handlers.screens }),
      );
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

      // Heartbeats prove this socket is alive, but they are not application
      // state and never establish a replay boundary of their own.
      if (isLivePing(frame)) {
        // An open event only proves that a TCP handshake happened. A ping
        // proves the stream stayed usable, so only now forgive prior flaps.
        retryAttempt = 0;
        return;
      }

      if (frame.kind === "hello") {
        // `resumed:true` is followed by replay frames. Advancing to hello's
        // newest cursor here would skip any replay frame not yet delivered if
        // this socket died mid-replay. A failed resume has no replay, but its
        // cursor is safe only after the consumer's replacement snapshot loads.
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
            // The consumer resolved only after applying every frame it held
            // behind the snapshot. Commit the newest delivered cursor, or the
            // hello boundary when no application frame arrived meanwhile.
            cursor = pending.newestFrameCursor ?? pending.boundaryCursor;
            pendingSnapshot = null;
          })();
        }
      } else if (event.lastEventId) {
        if (pendingSnapshot?.source === current) {
          pendingSnapshot.newestFrameCursor = event.lastEventId;
        } else {
          cursor = event.lastEventId;
        }
      }

      // Hello is transport control, not application state. Consumers rebuild
      // through onSnapshotRequired and receive only numbered application data.
      if (frame.kind !== "hello") handlers.onFrame(frame);
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
    // Background tabs suspend timers and network delivery. Let visibility or
    // focus perform one recovery on wake instead of churning hidden sockets.
    if (stopped || !platform.isOnline() || !platform.isVisible()) return;
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

  connect();
  const staleTimer = setInterval(recover, staleCheckMs);
  platform.windowTarget?.addEventListener("online", onOnline);
  platform.windowTarget?.addEventListener("focus", onFocus);
  platform.documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(staleTimer);
    clearRetry();
    closeSource();
    platform.windowTarget?.removeEventListener("online", onOnline);
    platform.windowTarget?.removeEventListener("focus", onFocus);
    platform.documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
