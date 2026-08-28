/** Live `/api/events` connection for the UI.
 *
 * Browser EventSource never surfaces SSE comment keepalives (`: ping`), so a
 * Tailscale/Vite proxy that holds a half-dead socket looks "open" forever and
 * chat bubbles stop arriving. The harness therefore emits a `kind:"ping"`
 * data frame; this helper reconnects with `?since=` when those go silent. */

export const LIVE_EVENTS_PATH = "/api/events";
/** Two missed 15s pings, with slack for a slow hop. */
export const SSE_STALE_MS = 40_000;

export function liveEventsUrl(opts?: { since?: string | null; screens?: boolean }): string {
  const params = new URLSearchParams();
  if (opts?.since) params.set("since", opts.since);
  if (opts?.screens === false) params.set("screens", "off");
  const query = params.toString();
  return query ? `${LIVE_EVENTS_PATH}?${query}` : LIVE_EVENTS_PATH;
}

export function shouldReconnectLiveEvents(lastHeardAt: number, now: number, staleMs = SSE_STALE_MS): boolean {
  return now - lastHeardAt >= staleMs;
}

export function isLivePing(frame: { kind?: unknown }): boolean {
  return frame.kind === "ping";
}

export interface LiveFrame {
  kind?: string;
  cursor?: string;
  resumed?: boolean;
  threadId?: string;
  message?: unknown;
  event?: unknown;
  seq?: number;
}

export interface LiveEventsHandlers {
  onFrame: (frame: LiveFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
  screens?: boolean;
  staleMs?: number;
  now?: () => number;
  eventSource?: typeof EventSource;
}

export function openLiveEvents(handlers: LiveEventsHandlers): () => void {
  const EventSrc = handlers.eventSource ?? globalThis.EventSource;
  const staleMs = handlers.staleMs ?? SSE_STALE_MS;
  const now = handlers.now ?? Date.now;
  let closed = false;
  if (!EventSrc) {
    handlers.onError?.();
    return () => {
      closed = true;
    };
  }
  let source: EventSource | null = null;
  let lastEventId = "";
  let lastHeard = now();
  let connecting = false;

  const connect = () => {
    if (closed || connecting) return;
    connecting = true;
    source?.close();
    source = new EventSrc(liveEventsUrl({ since: lastEventId || null, screens: handlers.screens }));
    source.onopen = () => {
      connecting = false;
      lastHeard = now();
      handlers.onOpen?.();
    };
    source.onerror = () => {
      connecting = false;
      handlers.onError?.();
    };
    source.onmessage = (raw) => {
      lastHeard = now();
      if (raw.lastEventId) lastEventId = raw.lastEventId;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (!parsed || Array.isArray(parsed) || Object(parsed) !== parsed) return;
      // SAFETY: SSE data lines are JSON objects with kind/cursor.
      const frame = parsed as LiveFrame;
      if (frame.cursor && frame.kind === "hello" && !raw.lastEventId) {
        lastEventId = frame.cursor;
      }
      if (isLivePing(frame)) return;
      handlers.onFrame(frame);
    };
  };

  const poke = () => {
    if (closed) return;
    if (!shouldReconnectLiveEvents(lastHeard, now(), staleMs)) return;
    handlers.onError?.();
    connecting = false;
    connect();
  };

  connect();
  const timer = setInterval(poke, Math.min(10_000, Math.max(1_000, staleMs / 2)));
  const onVisible = () => {
    if (document.visibilityState === "visible") poke();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", poke);
  window.addEventListener("focus", poke);

  return () => {
    closed = true;
    clearInterval(timer);
    source?.close();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", poke);
    window.removeEventListener("focus", poke);
  };
}
