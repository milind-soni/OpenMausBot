import { WebSocket, type RawData } from "ws";
import type { Context } from "./context.ts";
import { Close, parseObject } from "./wire.ts";

export type MessageHandler = (data: Buffer, isBinary: boolean) => void;

/** Closes with `code` when the socket is open; the server's closeTimeout cuts a peer that never answers the close. */
export function closeWith(ctx: Context, ws: WebSocket, code: number, reason?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ctx.metrics.inc("relay_closes_total", code);
    ws.close(code, reason);
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  }
}

export function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

/**
 * The pre-auth rule for every path: exactly one text message of at most `authMessageBytes`, holding a JSON object,
 * within `authDeadlineMs`; anything else closes with 4400. `first` gets that object and returns the handler for every
 * later message, or nothing when it closed the socket.
 */
export function afterFirstMessage(ctx: Context, ws: WebSocket, first: (message: Record<string, unknown>) => MessageHandler | undefined): void {
  const { authDeadlineMs, authMessageBytes } = ctx.limits;
  let next: MessageHandler | undefined;
  let seen = false;
  const deadline = setTimeout(() => closeWith(ctx, ws, Close.Malformed), authDeadlineMs);
  ws.once("close", () => clearTimeout(deadline));
  ws.on("message", (raw: RawData, isBinary: boolean) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const data = raw as Buffer;
    if (next) return next(data, isBinary);
    if (seen) return;
    seen = true;
    clearTimeout(deadline);
    const message = !isBinary && data.length <= authMessageBytes ? parseObject(data.toString("utf8")) : undefined;
    if (!message) return closeWith(ctx, ws, Close.Malformed);
    next = first(message);
  });
}

/**
 * Pings every tracked socket each `pingIntervalMs` and cuts the ones that showed no sign of life `pongTimeoutMs` later.
 * A pong, a message, or a write to the socket completing all count as life. A socket the relay itself paused is skipped:
 * its pong sits unread behind the pause, and the splice's wedge timer covers it.
 */
export class Heartbeat {
  private readonly alive = new Map<WebSocket, boolean>();
  private readonly ctx: Context;
  private pinger: NodeJS.Timeout | undefined;
  private checker: NodeJS.Timeout | undefined;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  start(): void {
    this.pinger = setInterval(() => this.ping(), this.ctx.limits.pingIntervalMs);
  }

  stop(): void {
    clearInterval(this.pinger);
    clearTimeout(this.checker);
  }

  track(ws: WebSocket): void {
    if (this.alive.has(ws)) return;
    this.alive.set(ws, true);
    ws.on("pong", () => this.mark(ws));
    ws.once("close", () => this.alive.delete(ws));
  }

  mark(ws: WebSocket): void {
    if (this.alive.has(ws)) this.alive.set(ws, true);
  }

  private ping(): void {
    for (const ws of this.alive.keys()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      this.alive.set(ws, false);
      ws.ping();
    }
    clearTimeout(this.checker);
    this.checker = setTimeout(() => this.check(), this.ctx.limits.pongTimeoutMs);
  }

  private check(): void {
    for (const [ws, alive] of this.alive) {
      if (alive || ws.isPaused || ws.readyState !== WebSocket.OPEN) continue;
      this.ctx.metrics.inc("relay_pong_timeouts_total");
      ws.terminate();
    }
  }
}
