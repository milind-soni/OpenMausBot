// The page's way to its own server's `/api` routes: through MausBot Relay while it holds a relay pairing (a phone
// browser away from home, src/lib/e2e/relay-link.ts), as a plain same-origin request otherwise.
import type { RelayLink } from "./e2e/relay-link";
import type { LiveEventSourceLike } from "./live-events";

let link: RelayLink | null = null;

/** Sends this page's `/api` requests and live events through `next` from now on; null goes back to plain requests. A link
 * that is replaced is closed. */
export function setRelayLink(next: RelayLink | null): void {
  if (link === next) return;
  link?.close();
  link = next;
}

export function relayLink(): RelayLink | null {
  return link;
}

const API = /^\/api(?:[/?#]|$)/;

/** `fetch` for a path on this page's own server. */
export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const current = link;
  if (!current || !API.test(path)) return fetch(path, init);
  // A Request turns any body fetch takes (FormData, Blob, URLSearchParams…) into bytes and gives it its content type.
  const request = new Request(new URL(path, "http://relay.invalid"), { ...init, signal: undefined });
  const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  return current.fetch(path, { method: request.method, headers: request.headers, body, signal: init.signal ?? undefined });
}

/** An EventSource on `url` through `current`, as the live events transport uses it (src/lib/live-events.ts): `onerror`
 * once, when the stream can't open or ends, and the caller reconnects. Like EventSource, only unnamed and `message`
 * events reach `onmessage`. */
export function relayEventSource(current: RelayLink, url: string): LiveEventSourceLike {
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
      pending += decoder.decode(value, { stream: true });
      // A lone CR at the end may be the first half of a CRLF: it waits for the next chunk.
      const parts = pending.split(/\r\n|\r(?!$)|\n/);
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
