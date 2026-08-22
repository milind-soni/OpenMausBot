// What the harness says, minus what a device has no business holding.
//
// `resumeCursors` is the harness's own bookkeeping: the native session id to
// resume, per instance, per task. It goes out on every bot payload and every
// `bot` SSE frame. That is harmless noise while every client is the machine
// itself, and stops being harmless the moment a client is a phone on someone
// else's wifi.
//
// Upstream may fix this at source — there is a PR open for it — at which
// point this becomes a no-op rather than a lie, which is the right way for a
// sidecar to depend on someone else's API: assume nothing, and be correct
// either way.
//
// `sshAlias` is the same story with a different payload: the harness's config
// status echoes the self-hosted VPS alias — a label naming one of the user's
// servers — inside `vps`, on both GET /api/config and the `config` SSE frame.
// The phone only ever renders configured-or-not, so it gets exactly that:
// `{configured: true}` survives, the host label does not.

/** Keys that are the harness's business, never a device's. */
const WITHHELD_KEYS = new Set(["resumeCursors", "sshAlias"]);

/** Recursively drop the withheld keys, wherever they appear. */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (WITHHELD_KEYS.has(key)) continue;
      out[key] = scrub(inner);
    }
    return out as T;
  }
  return value;
}

/** True when a body is worth parsing at all. Anything else passes through
 * untouched — an image endpoint must never be JSON.parsed.
 *
 * The `+json` suffix counts. `application/problem+json` is JSON by every
 * measure that matters here, and a scrubber that skips it is a scrubber with
 * a hole in it: the harness only has to answer one error with RFC 9457 for
 * `resumeCursors` to reach a phone unscrubbed. Structured suffixes are the
 * registered way to say "this is JSON underneath" (RFC 6839), so honour it. */
export const isJson = (contentType: string | undefined): boolean => {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
};

/** How much of a single SSE event the scrubber will hold while waiting for
 * its terminator. Generous — the largest real frame is a bot payload, orders
 * of magnitude under this — because the number only exists to be a ceiling. */
export const MAX_SSE_EVENT_BYTES = 1024 * 1024;

/**
 * Rewrites an SSE byte stream, scrubbing each event's `data:` payload while
 * leaving everything else exactly as it arrived.
 *
 * Two properties this has to hold, both learned the hard way on the client
 * side of this same stream:
 *
 * - **It must not swallow blank lines.** The blank line *is* the event
 *   terminator; a transform that normalises whitespace produces a stream
 *   that parses to nothing and looks perfectly healthy at both ends.
 * - **It must not wait for more than one event.** Buffering to a frame
 *   boundary is bounded and fine. Buffering for a fixed size or a timer
 *   turns a live stream into a batch one, and the symptom is a phone that
 *   sits on "Connecting…" while the server logs a healthy connection.
 *
 * `id:` lines are preserved verbatim: they are the resume cursor, and
 * rewriting them would silently break `?since=`.
 *
 * Both line endings are recognised. The spec allows CRLF, LF, or a bare CR as
 * a line terminator, and a scrubber that knows only LF does not fail loudly
 * against a CRLF producer — it buffers the whole stream waiting for a boundary
 * that never comes, and the phone sits on "Connecting…" against a server that
 * is streaming perfectly. Whichever ending an event arrived with is the one it
 * leaves with; this rewrites payloads, not framing.
 *
 * Buffering to a frame boundary is bounded by the sender's good behaviour,
 * which is not a bound. A stream that never sends a terminator in any of its
 * spellings grows `pending` forever, so the buffer has a ceiling and passing
 * it throws: there is no safe way to flush half an event — emitting it
 * unterminated corrupts the stream, emitting it unscrubbed defeats the point
 * of this file. The caller drops the connection instead.
 */
export function createSseScrubber(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    pending += chunk;
    let out = "";
    for (;;) {
      const boundary = nextBoundary(pending);
      if (!boundary) break;
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.terminator.length);
      out += scrubEvent(event) + boundary.terminator;
    }
    if (pending.length > MAX_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without a terminator`);
    }
    return out;
  };
}

/** The first event terminator in `text`, whichever spelling it uses.
 *
 * A partial terminator at the end of a chunk — `…\r\n\r` — matches neither
 * and stays buffered, which is the correct answer: the rest is one chunk
 * away, and splitting an event across a scrub would corrupt it. */
function nextBoundary(text: string): { index: number; terminator: string } | null {
  let best: { index: number; terminator: string } | null = null;
  for (const terminator of ["\n\n", "\r\n\r\n", "\r\r"]) {
    const index = text.indexOf(terminator);
    if (index < 0) continue;
    // Earliest wins, and on a tie the longer terminator does: an LF-only match
    // inside a CRLF pair would cut the event a byte short of its real end.
    if (!best || index < best.index || (index === best.index && terminator.length > best.terminator.length)) {
      best = { index, terminator };
    }
  }
  return best;
}

/** One complete SSE event, `data:` payload scrubbed, everything else kept. */
function scrubEvent(event: string): string {
  // The ending this event arrived with is the one it leaves with.
  const eol = event.includes("\r\n") ? "\r\n" : event.includes("\r") ? "\r" : "\n";
  return event
    .split(/\r\n|\r|\n/)
    .map((line) => {
      // `: keepalive` comments, `id:`, `event:`, `retry:` — not ours to touch
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trimStart();
      if (!raw) return line;
      try {
        return `data: ${JSON.stringify(scrub(JSON.parse(raw)))}`;
      } catch {
        // not JSON: pass it through rather than dropping it. A frame this
        // code does not understand is still the harness's to send.
        return line;
      }
    })
    .join(eol);
}
