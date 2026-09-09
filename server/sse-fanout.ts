// Per-client delivery decision for the SSE broadcast fan-out in index.ts.
// Pulled into its own file — not just its own function — because index.ts
// starts the real HTTP server as an import-time side effect (see the bottom
// of index.ts: `server.listen(...)` runs unconditionally on import), so it
// can never be imported from a plain unit test. This one function has no
// dependency on that module and can be driven directly with a fake response.

/** Shape broadcast() needs from an SSE client: a writable response, and the
 * one flag that survives across frames — whether its socket already told us
 * it can't keep up. */
export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
    once(event: "drain", listener: () => void): unknown;
  };
  backpressured: boolean;
}

/** Past this many buffered bytes, the client isn't draining on any useful
 * timeframe: cut it loose rather than let Node's per-connection write buffer
 * grow without bound. Its own EventSource reconnects and replays via
 * Last-Event-ID (server/index.ts's existing replayBuffer/cursorSeq). */
// ponytail: fixed byte bound, not adaptive. Retune from real writableLength
// telemetry (see the audit's validation step) if it trips too eager or late.
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

/** One client's fate for one frame.
 *
 * Screen captures are replaceable: once a client is backpressured, skip them
 * until it drains, since the next capture supersedes whatever was dropped.
 * Durable events (messages, bot/group state, config, ...) are never
 * silently dropped here — they're written regardless of the backpressure
 * flag. The only way a durable event goes missing is the bound below, which
 * disconnects the client outright so its next reconnect replays what it
 * missed instead of silently losing it. */
export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
    return "disconnected";
  }
  if (client.backpressured && kind === "screen") return "dropped";
  try {
    if (!client.res.write(frame) && !client.backpressured) {
      // write() returns false as soon as buffered bytes pass the socket's
      // 16 KB highWaterMark, which a single screen frame clears on its own —
      // so this says "hasn't drained yet", not "is a slow client". Without
      // the drain listener the flag latches on for the life of the
      // connection and screen streaming never resumes. One listener per
      // transition into backpressure, never one per frame.
      client.backpressured = true;
      client.res.once("drain", () => {
        client.backpressured = false;
      });
    }
    return "sent";
  } catch {
    return "disconnected";
  }
}
