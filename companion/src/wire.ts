// Scrubs what a device has no business holding: `resumeCursors` (native
// session ids, on every bot payload and `bot` frame), `sshAlias` (a label
// naming one of the user's servers) and a bot's own alias plus the
// inventory's alias tags (`vpsAlias`, `vpsAliases`). Correct whether or not
// upstream stops sending them. Keys only: no phone-reachable string names an
// alias, and cutting a value out of every string would also cut a short
// alias such as "vps" out of `cloudBackend: "vps"` and the user's messages.
const WITHHELD_KEYS = new Set(["resumeCursors", "sshAlias", "vpsAlias", "vpsAliases"]);

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

/** Anything else passes through untouched. `+json` counts (RFC 6839): one RFC
 * 9457 problem response would otherwise carry `resumeCursors` to a phone. */
export const isJson = (contentType: string | undefined): boolean => {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
};

/** Above the harness's 3 MiB browser-live frame cap (`MAX_FRAME`), with
 * headroom for the JSON and SSE wrapping. */
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Scrubs each event's `data:` payload and leaves everything else as it arrived:
 * blank lines are the event terminator, `id:` lines are the resume cursor, and
 * each event keeps its own line ending (the spec allows CRLF, LF or a bare CR).
 * Holds at most one event; past MAX_SSE_EVENT_BYTES it throws, since half an
 * event can be neither flushed nor scrubbed, and the caller drops the stream.
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
      if (Buffer.byteLength(event) > MAX_SSE_EVENT_BYTES) {
        throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
      }
      pending = pending.slice(boundary.index + boundary.terminator.length);
      out += scrubEvent(event) + boundary.terminator;
    }
    if (Buffer.byteLength(pending) > MAX_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without a terminator`);
    }
    return out;
  };
}

/** A partial terminator at a chunk's end (`…\r\n\r`) matches neither and stays
 * buffered. */
function nextBoundary(text: string): { index: number; terminator: string } | null {
  let best: { index: number; terminator: string } | null = null;
  for (const terminator of ["\n\n", "\r\n\r\n", "\r\r"]) {
    const index = text.indexOf(terminator);
    if (index < 0) continue;
    // On a tie the longer terminator wins: an LF inside a CRLF pair would cut
    // the event a byte short.
    if (!best || index < best.index || (index === best.index && terminator.length > best.terminator.length)) {
      best = { index, terminator };
    }
  }
  return best;
}

function scrubEvent(event: string): string {
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
        // Not JSON: still the harness's to send.
        return line;
      }
    })
    .join(eol);
}
