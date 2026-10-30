import type { IncomingMessage, ServerResponse } from "node:http";

export const BODY_DEADLINE_MS = 55_000;
/** The slowest upload still let through: past this pace a large body is cut off, never held open. */
const MIN_BODY_BYTES_PER_SECOND = 128 * 1024;
const UNKNOWN_LENGTH_BYTES = 32 * 1024 * 1024;
const TIMED_OUT_BODY = JSON.stringify({ error: "The request took too long. Check the connection and try again." });
const TIMED_OUT = `HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(TIMED_OUT_BODY)}\r\n\r\n${TIMED_OUT_BODY}`;

/** Ends a request whose body has not all arrived in time, as Node's own `requestTimeout` does: a 408 written on the
 * socket, then the connection closed. A request without a body (a stream, a long poll) is never timed. */
export function holdBodyDeadline(req: IncomingMessage, res: ServerResponse, baseMs = BODY_DEADLINE_MS): void {
  const declared = Number(req.headers["content-length"] ?? 0);
  const chunked = req.headers["transfer-encoding"] !== undefined;
  if (req.complete || (!chunked && !(declared > 0))) return;
  const bytes = chunked ? UNKNOWN_LENGTH_BYTES : declared;
  const timer = setTimeout(() => {
    if (req.complete) return;
    const socket = req.socket;
    if (!res.headersSent && socket.writable) socket.end(TIMED_OUT, () => socket.destroy());
    else socket.destroy();
  }, baseMs + Math.ceil((bytes / MIN_BODY_BYTES_PER_SECOND) * 1000));
  timer.unref();
  req.once("end", () => clearTimeout(timer));
  req.once("close", () => clearTimeout(timer));
}
