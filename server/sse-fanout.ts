export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    writableLength: number;
    once(event: "drain", listener: () => void): unknown;
  };
  backpressured: boolean;
  /** The client's idempotent lifecycle owner: it leaves the fanout and stops the heartbeat before ending the response. */
  close(): void;
}

/** Past this, cut the client loose; its EventSource reconnects and replays via Last-Event-ID. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

/** Only screen captures are skipped while backpressured; durable events are always written, or the client is disconnected to replay them. */
export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    client.close();
    return "disconnected";
  }
  if (client.backpressured && kind === "screen") return "dropped";
  try {
    if (!client.res.write(frame) && !client.backpressured) {
      // write() returns false past the 16 KB highWaterMark, which one screen frame clears: it means "not drained yet", and without the drain listener the flag latches forever.
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

export interface SseHeartbeatStream {
  write(chunk: string): boolean;
  end(): void;
  writableEnded: boolean;
  destroyed: boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
}

const SSE_HEARTBEAT_FRAME = `: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`;

/** Heartbeats `res` while `live()` holds. The returned close stops the heartbeat and runs `onClose` once, before the response ends; it runs by itself when the stream ends, errors or stops being live. */
export function openSseHeartbeat(res: SseHeartbeatStream, options: { everyMs: number; live: () => boolean; onClose: () => void }): () => void {
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(timer);
    options.onClose();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || !options.live()) return close();
    try {
      res.write(SSE_HEARTBEAT_FRAME);
    } catch {
      close();
    }
  }, options.everyMs);
  // Node reports a failed write, such as one after end, as an asynchronous 'error' event on the response; unhandled, it exits the process.
  res.on("error", close);
  return close;
}
