import type { Readable } from "node:stream";

/** A JSON-RPC 2.0 message as ACP agents actually send them. */
export interface AcpWireMessage {
  jsonrpc?: "2.0";
  // JSON-RPC ids may be numbers, strings, or null; agents do send string
  // ids, and a null id still names a dispatchable server request
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Complete lines in a stream buffer, plus the unterminated tail to keep. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/u, "")), rest };
}

export interface AcpConnectionOptions {
  /** Write one serialized frame (the agent's stdin). A throw is the caller's
   *  policy: the turn runtime swallows write errors after the child is gone,
   *  probe clients let them reject the request that caused them. */
  write(line: string): void;
  /** The agent's stdout; the connection frames complete lines off it. */
  stdout: Readable;
  /** Observe every raw chunk before framing (startup byte counters). */
  onData?(chunk: string): void;
  /** First look at a complete line (sign-in link announcements). Return true
   *  to keep the line out of protocol parsing. */
  onLine?(line: string): boolean | undefined;
  /** Observe every outgoing message after its frame is written (native log). */
  onSend?(message: AcpWireMessage): void;
  /** Observe every parsed incoming message before dispatch (native log). */
  onMessage?(message: AcpWireMessage): void;
  /** A server→client request (id + method, no result yet). */
  onServerRequest?(message: AcpWireMessage): void;
  /** A server→client notification (method, no id). */
  onNotification?(message: AcpWireMessage): void;
  /** Called once when close() marks the connection closed — the kill policy
   *  stays with the driver that owns the process. */
  onClose?(): void;
/** Called when the agent stdout emits an error — kept separate from the
   *  child-process and stdin error paths so a driver can classify a failed
   *  host read (and its rejected requests) on its own terms. */
  onHostReadError?(error: Error): void;
  /** Fail every pending request when the buffer grows past this many bytes.
   *  Unset bounds the line at 16 MiB — no connection buffers without end. */
  maxLineBytes?: number;
  /** Rejection message when a frame outgrows maxLineBytes. */
  oversizedLineMessage?: string;
  /** Rejection for requests made after close(). */
  closedErrorMessage?: string;
  /** Rejection handed to pending requests by close(). */
  closeErrorMessage?: string;
  /** Rejection message when an error response carries no message. */
  errorFallbackMessage?: string;
  /** Rejection message when a request times out. */
  timeoutMessage?(method: string, timeoutMs: number): string;
}

/** One client→agent request awaiting its response. */
interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Provider error text is unbounded on the wire; cap what lands in an Error
 *  message so one giant provider string cannot balloon logs and memory. */
const PROVIDER_ERROR_MESSAGE_LIMIT = 512;

/** One JSON-RPC-2.0-over-stdio connection to an ACP agent. The connection
 *  owns framing, request/response correlation, timeouts, and dispatch of
 *  notifications and server→client requests; the caller owns the process and
 *  every policy (logging, permission answers, shutdown). */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private buffer = "";
  private closed = false;
  private readonly options: AcpConnectionOptions;

  constructor(options: AcpConnectionOptions) {
    this.options = options;
    // decode as UTF-8 across chunk boundaries — a raw `buffer += chunk` splits
    // multibyte characters that straddle two reads and corrupts the text
    options.stdout.setEncoding("utf8");
    options.stdout.on("error", (error: Error) => {
      // stdout is the only transport: an unhandled error event would crash
      // the host process, and pending requests would wait on a stream that
      // will never read again. Fail them with a distinct host-read error,
      // close the connection, then tell the driver on the dedicated
      // callback — separate from child-process and stdin failures.
      this.failAll(new Error(`ACP agent stdout failed: ${error.message}`));
      this.close();
      this.options.onHostReadError?.(error);
    });
    options.stdout.on("data", (chunk: string) => {
      try {
        this.consume(chunk);
      } catch (error) {
        // A protocol callback threw inside the stream listener (onData, onLine,
        // onServerRequest, onNotification): contain it at this boundary,
        // reject every pending request with the original error, and close
        // so a half-dispatched stream cannot keep flowing.
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.close();
      }
    });
  }

  /** Whether close() has run — later requests reject. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Serialize and write one message — a request, a notification, or a
   *  response to a server request. */
  send(message: AcpWireMessage): void {
    this.options.write(`${JSON.stringify(message)}\n`);
    try {
      this.options.onSend?.(message);
    } catch (error) {
      // observers are diagnostics; a throw here must not unwind into
      // request cleanup and reject a request whose frame was written
      console.error("ACP onSend observer failed", error);
    }
  }

  /** Send a request and await its response. No `timeoutMs` means no timer —
   *  the request waits until the connection ends. `onResult` fires from the
   *  read loop before the awaiting continuation resumes, so an update that
   *  follows the response is still consumed in wire order. */
  request(method: string, params: unknown, timeoutMs?: number, onResult?: (result: any) => void): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.options.closedErrorMessage ?? "The ACP connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(this.options.timeoutMessage?.(method, timeoutMs) ?? `${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (result) => {
          try {
            onResult?.(result);
          } catch (error) {
            // a throwing callback used to strand the promise and escape the
            // stdout listener; settle the request with the callback's error
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          resolve(result);
        },
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Reject every pending request — a settled turn, an exited process, or
   *  close(). Timers are cleared so a late timeout cannot follow. */
  failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Mark the connection closed, drop buffered bytes, reject pending
   *  requests, and hand the process to onClose. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    this.failAll(new Error(this.options.closeErrorMessage ?? "The ACP connection was closed."));
    this.options.onClose?.();
  }

  /** Fail every pending request and close the connection — one protocol
   *  line outgrew maxLineBytes. */
  private failOversized(): void {
    this.failAll(new Error(this.options.oversizedLineMessage ?? "The ACP connection received a protocol line that is too large."));
    this.close();
  }

  private consume(chunk: string) {
    // close() can run while the child still emits — its kill chain is
    // asynchronous — so post-close chunks are dropped, never buffered
    if (this.closed) return;
    this.options.onData?.(chunk);
    // onData is a driver callback too; it can close the connection
    if (this.closed) return;
    this.buffer += chunk;
    const { lines, rest } = takeLines(this.buffer);
    this.buffer = rest;
    // One stdout event can carry many framed lines; the limit is per line.
    // Each complete line is checked in wire order, so valid frames that
    // precede an oversized one still dispatch before the connection fails;
    // the partial tail is checked only after every complete line.
    // every connection is bounded even when its driver sets no limit: an
    // unterminated line from a malfunctioning agent cannot grow the read
    // buffer forever (16 MiB, the same cap the antigravity driver sets)
    const maxLineBytes = this.options.maxLineBytes ?? 16 * 1024 * 1024;
    const oversized = (value: string) => Buffer.byteLength(value) > maxLineBytes;
    for (const line of lines) {
      if (this.closed) return;
      if (oversized(line)) {
        this.failOversized();
        return;
      }
      // the onLine return value says whether the line was consumed, not
      // that dispatch may continue — it can close the connection
      const intercepted = this.options.onLine?.(line);
      if (this.closed) return;
      if (intercepted) continue;
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        record = parsed as Record<string, unknown>;
        // the envelope gates dispatch: a frame that is not JSON-RPC 2.0
        // must not resolve a pending request or reach a request handler
        if (record.jsonrpc !== "2.0") continue;
      } catch {
        continue;
      }
      const message = record as AcpWireMessage;
      try {
        this.options.onMessage?.(message);
      } catch (error) {
        // the observer is a diagnostic; dispatch continues with the message
        console.error("ACP onMessage observer failed", error);
      }
      if (this.closed) return;
      const hasId = "id" in record;
      if (hasId && ("result" in record || "error" in record)) {
        // pending ids are the numbers this connection issued; a response
        // keyed by anything else — null included — matches no pending entry
        if (typeof message.id !== "number") continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if ("error" in record) {
          const rpcError = record.error;
          if (!rpcError || typeof rpcError !== "object" || Array.isArray(rpcError)) {
            pending.reject(new Error(this.options.errorFallbackMessage ?? "The ACP agent returned an invalid error response."));
          } else {
            const details = rpcError as NonNullable<AcpWireMessage["error"]>;
            const raw = typeof details.message === "string"
              ? details.message
              : this.options.errorFallbackMessage ?? "ACP provider error";
            const error = new Error(
              raw.length > PROVIDER_ERROR_MESSAGE_LIMIT
                ? `${raw.slice(0, PROVIDER_ERROR_MESSAGE_LIMIT)}…[truncated]`
                : raw,
            );
            Object.assign(error, { code: details.code, data: details.data });
            pending.reject(error);
          }
        } else {
          pending.resolve(message.result);
        }
      } else if (hasId && typeof message.method === "string") {
        // an id member makes it a request even when the id is null; JSON-RPC
        // 2.0 ids are string | number | null — anything else cannot be
        // correlated with a reply, so answer Invalid Request and skip it
        const id: unknown = message.id;
        if (id !== null && typeof id !== "string" && typeof id !== "number") {
          this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
          continue;
        }
        this.options.onServerRequest?.(message);
      } else if (typeof message.method === "string") {
        this.options.onNotification?.(message);
      }
      // every dispatch callback above — onResult inside resolve included —
      // can close the connection; no later line may dispatch after that
      if (this.closed) return;
    }
    if (this.closed) return;
    if (oversized(this.buffer)) {
      this.failOversized();
    }
  }
}
