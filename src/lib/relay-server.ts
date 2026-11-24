// The page's way to its own server's `/api` routes: through MausBot Relay while it holds a relay pairing (a phone
// browser away from home, src/lib/e2e/relay-link.ts), as a plain same-origin request otherwise.
// It imports nothing: server code type-checks src/lib/composer-attachments.ts, whose uploads come through here, and
// must not take in the browser's relay crypto (e2e/) or the live events store with it.

/** What this file uses of a RelayLink (src/lib/e2e/relay-link.ts). */
export interface ServerLink {
  fetch(path: string, request?: { method?: string; headers?: Headers | Record<string, string>; body?: Uint8Array | null; signal?: AbortSignal }): Promise<Response>;
  close(): void;
}

/** An EventSource as the live events transport uses it (src/lib/live-events.ts): the browser's own, or one through
 * the relay link. */
export interface LiveEventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  close: () => void;
}

let link: ServerLink | null = null;

/** Sends this page's `/api` requests and live events through `next` from now on; null goes back to plain requests. A link
 * that is replaced is closed. */
export function setRelayLink(next: ServerLink | null): void {
  if (link === next) return;
  link?.close();
  link = next;
}

export function relayLink(): ServerLink | null {
  return link;
}

/** The server's own routes: `/api`, and the environment descriptor that says what this server is. */
const API = /^\/(?:api(?:[/?#]|$)|\.well-known\/openmausbot\/environment(?:[?#]|$))/;

/** `path` as a request to this page's own server routes (API): a root path, or an absolute URL on this page's origin
 * (some links are built from `location`); null for anything else. */
function ownApiPath(path: string): string | null {
  if (API.test(path)) return path;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) return null;
  // Parsed, so the same origin written another way (an explicit default port, upper case) still counts.
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return null;
  }
  return url.origin === origin && API.test(url.pathname) ? url.pathname + url.search : null;
}

/** `fetch` for a path on this page's own server. Over the relay, `keepalive` does not apply: the link lives in this page
 * and ends with it. */
export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const current = link;
  const own = current ? ownApiPath(path) : null;
  // Called as the caller called it: with no options when it gave none.
  if (!current || own === null) return init ? fetch(path, init) : fetch(path);
  // A Request turns any body fetch takes (FormData, Blob, URLSearchParams…) into bytes and gives it its content type.
  const request = new Request(new URL(own, "http://relay.invalid"), { ...init, signal: undefined });
  const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  // The normalized target: spaces and other unsafe characters encoded, any fragment left out.
  const { pathname, search } = new URL(request.url);
  return current.fetch(pathname + search, { method: request.method, headers: request.headers, body, signal: init?.signal ?? undefined });
}

/** An EventSource on `url` through `current`, as the live events transport uses it (src/lib/live-events.ts): `onerror`
 * once, when the stream can't open or ends, and the caller reconnects. Like EventSource, only unnamed and `message`
 * events reach `onmessage`. */
export function relayEventSource(current: ServerLink, url: string): LiveEventSourceLike {
  const stop = new AbortController();
  const source: LiveEventSourceLike = { onopen: null, onerror: null, onmessage: null, close: () => stop.abort() };
  void (async () => {
    try {
      const reply = await current.fetch(url, { headers: { accept: "text/event-stream" }, signal: stop.signal });
      if (!reply.ok || !reply.body || !/^text\/event-stream\b/i.test(reply.headers.get("content-type") ?? "")) {
        await reply.body?.cancel().catch(() => {});
        throw new Error(`live events refused (${reply.status})`);
      }
      if (stop.signal.aborted) return;
      source.onopen?.();
      await readEvents(reply.body, stop.signal, (data, lastEventId) => source.onmessage?.({ data, lastEventId }));
    } catch {
      // Reported below, as the end of the stream.
    }
    if (!stop.signal.aborted) source.onerror?.();
  })();
  return source;
}

/** The text/event-stream format (HTML Living Standard, "Interpreting an event stream"). */
async function readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, dispatch: (data: string, lastEventId: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  // A chunk that ended in CR has ended that line already; an LF that starts the next chunk belongs to the same CRLF.
  let skipLF = false;
  let data: string[] = [];
  let type = "";
  let lastEventId = "";
  const line = (text: string) => {
    if (text === "") {
      if (data.length && (type === "" || type === "message")) dispatch(data.join("\n"), lastEventId);
      data = [];
      type = "";
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(text[colon + 1] === " " ? colon + 2 : colon + 1);
    if (field === "data") data.push(value);
    else if (field === "event") type = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      let text = decoder.decode(value, { stream: true });
      if (skipLF && text.startsWith("\n")) {
        text = text.slice(1);
        skipLF = false;
      }
      if (text) skipLF = text.endsWith("\r");
      pending += text;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop()!;
      for (const part of parts) {
        line(part);
        if (signal.aborted) return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
