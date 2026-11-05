import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import type { Context } from "./context.ts";
import type { HostEntry } from "./hosts.ts";
import { TokenBucket } from "./limits.ts";
import { closeWith, sendJson } from "./socket.ts";
import { Close, PASS_THROUGH_CODES } from "./wire.ts";

const BACKPRESSURE = 1;
const THROTTLE = 2;
const HEAVY_SLOTS = 30;

/**
 * Bytes a session moved in each of the last HEAVY_SLOTS slices of the heavy window. `add` says when a session that is at
 * least one window old has averaged more than the heavy rate across the whole window.
 */
export class HeavyMeter {
  private readonly slots = new Float64Array(HEAVY_SLOTS);
  private readonly slotMs: number;
  private readonly limitBytes: number;
  private readonly started: number;
  private slot: number;
  private sum = 0;

  constructor(windowMs: number, heavyBitsPerSecond: number, now: number) {
    this.slotMs = windowMs / HEAVY_SLOTS;
    this.limitBytes = (heavyBitsPerSecond / 8) * (windowMs / 1000);
    this.started = now;
    this.slot = Math.floor(now / this.slotMs);
  }

  add(bytes: number, now: number): boolean {
    const slot = Math.floor(now / this.slotMs);
    if (slot !== this.slot) {
      for (let s = this.slot + 1; s <= Math.min(slot, this.slot + HEAVY_SLOTS); s++) {
        this.sum -= this.slots[s % HEAVY_SLOTS]!;
        this.slots[s % HEAVY_SLOTS] = 0;
      }
      this.slot = slot;
    }
    this.slots[slot % HEAVY_SLOTS]! += bytes;
    this.sum += bytes;
    return now - this.started >= this.slotMs * HEAVY_SLOTS && this.sum > this.limitBytes;
  }
}

/** One way through a splice. The source is read only while `paused` is 0. */
interface Direction {
  src: WebSocket;
  dst: WebSocket;
  paused: number;
  lastProgress: number;
  wedge: NodeJS.Timeout | undefined;
  sent: (error?: Error) => void;
}

export type SessionState = "pending" | "spliced" | "closed";

/**
 * A phone waiting for its host's data socket, then the two sockets spliced. The relay forwards whole binary messages
 * and never drops one: when the destination falls behind it stops reading the source.
 */
export class Session {
  readonly sid = randomBytes(16).toString("base64url");
  readonly admHash: Buffer;
  state: SessionState = "pending";
  up = 0;
  down = 0;
  private readonly ctx: Context;
  private readonly entry: HostEntry;
  private readonly phone: WebSocket;
  private data: WebSocket | undefined;
  private readonly started: number;
  private readonly openTimer: NodeJS.Timeout;
  private toHost: Direction | undefined;
  private toPhone: Direction | undefined;
  private meter: HeavyMeter | undefined;
  private throttle: TokenBucket | undefined;
  private readonly throttleTimers = new Set<NodeJS.Timeout>();

  constructor(ctx: Context, entry: HostEntry, admHash: Buffer, phone: WebSocket) {
    this.ctx = ctx;
    this.entry = entry;
    this.admHash = admHash;
    this.phone = phone;
    this.started = ctx.now();
    entry.sessions.set(this.sid, this);
    this.openTimer = setTimeout(() => this.end(Close.NoDataSocket), ctx.limits.openDeadlineMs);
    phone.once("close", (code) => this.closed(phone, code));
  }

  /** The host's data socket arrived for this `sid`: splice, then tell the phone it may start its handshake. */
  splice(data: WebSocket): void {
    this.state = "spliced";
    this.data = data;
    clearTimeout(this.openTimer);
    const now = this.ctx.now();
    this.meter = new HeavyMeter(this.ctx.limits.heavyWindowMs, this.ctx.limits.heavyBitsPerSecond, now);
    this.toHost = this.direction(this.phone, data, now);
    this.toPhone = this.direction(data, this.phone, now);
    data.once("close", (code) => this.closed(data, code));
    this.ctx.heartbeat.track(this.phone);
    this.ctx.heartbeat.track(data);
    this.ctx.metrics.inc("relay_sessions_total");
    sendJson(this.phone, { t: "ready" });
  }

  fromPhone(data: Buffer, isBinary: boolean): void {
    if (this.state !== "spliced" || !isBinary) return this.end(Close.Malformed);
    this.up += data.length;
    this.ctx.metrics.inc("relay_bytes_total", "up", data.length);
    this.forward(this.toHost!, data);
  }

  fromHost(data: Buffer, isBinary: boolean): void {
    if (this.state !== "spliced" || !isBinary) return this.end(Close.Malformed);
    this.down += data.length;
    this.ctx.metrics.inc("relay_bytes_total", "down", data.length);
    this.forward(this.toPhone!, data);
  }

  /** The relay ends the session: both sockets close with `code`. */
  end(code: number, reason?: string): void {
    if (this.state === "closed") return;
    this.finish(code);
    closeWith(this.ctx, this.phone, code, reason);
    if (this.data) closeWith(this.ctx, this.data, code, reason);
  }

  private direction(src: WebSocket, dst: WebSocket, now: number): Direction {
    const dir: Direction = { src, dst, paused: 0, lastProgress: now, wedge: undefined, sent: () => {} };
    dir.sent = (error) => {
      if (error) return;
      dir.lastProgress = this.ctx.now();
      this.ctx.heartbeat.mark(dst);
      if (dir.paused & BACKPRESSURE && dst.bufferedAmount <= this.ctx.limits.lowWaterBytes) this.resume(dir, BACKPRESSURE);
    };
    return dir;
  }

  private forward(dir: Direction, data: Buffer): void {
    const { limits } = this.ctx;
    this.ctx.heartbeat.mark(dir.src);
    dir.dst.send(data, { binary: true }, dir.sent);
    if (this.state !== "spliced") return;
    if (this.ctx.budgets.add(this.entry.hidText, data.length)) return this.overBudget();
    const now = this.ctx.now();
    if (!this.throttle && this.meter!.add(data.length, now)) {
      const perMs = limits.throttleBitsPerSecond / 8 / 1000;
      this.throttle = new TokenBucket(Math.max(limits.maxPayloadBytes, perMs * 100), perMs, this.ctx.now);
      this.ctx.metrics.inc("relay_throttled_sessions_total");
      this.ctx.log({ ev: "throttle", hid8: this.entry.hid8 });
    }
    if (this.throttle) {
      const waitMs = this.throttle.spend(data.length);
      if (waitMs > 0 && !(dir.paused & THROTTLE)) {
        this.pause(dir, THROTTLE);
        const timer = setTimeout(() => {
          this.throttleTimers.delete(timer);
          this.resume(dir, THROTTLE);
        }, waitMs);
        this.throttleTimers.add(timer);
      }
    }
    if (dir.dst.bufferedAmount > limits.highWaterBytes && !(dir.paused & BACKPRESSURE)) {
      this.ctx.metrics.inc("relay_backpressure_pauses_total");
      dir.lastProgress = now;
      this.pause(dir, BACKPRESSURE);
      this.watchWedge(dir, limits.wedgeMs);
    }
  }

  /** While backpressure holds a source, a destination that takes nothing for `wedgeMs` ends the session. */
  private watchWedge(dir: Direction, delayMs: number): void {
    clearTimeout(dir.wedge);
    dir.wedge = setTimeout(() => {
      dir.wedge = undefined;
      if (!(dir.paused & BACKPRESSURE) || this.state !== "spliced") return;
      const idle = this.ctx.now() - dir.lastProgress;
      if (idle >= this.ctx.limits.wedgeMs) this.end(Close.Limited);
      else this.watchWedge(dir, this.ctx.limits.wedgeMs - idle);
    }, delayMs);
  }

  private pause(dir: Direction, reason: number): void {
    if (dir.paused === 0) dir.src.pause();
    dir.paused |= reason;
  }

  private resume(dir: Direction, reason: number): void {
    if (!(dir.paused & reason)) return;
    dir.paused &= ~reason;
    if (reason === BACKPRESSURE) clearTimeout(dir.wedge);
    if (dir.paused === 0 && this.state === "spliced") dir.src.resume();
  }

  private overBudget(): void {
    this.ctx.metrics.inc("relay_host_budget_exceeded_total");
    this.ctx.log({ ev: "budget", hid8: this.entry.hid8 });
    for (const session of this.entry.sessions.values()) session.end(Close.Limited);
  }

  /** One of the two sockets closed: the other gets the same code when it is one the ends use with each other. */
  private closed(socket: WebSocket, code: number): void {
    if (this.state === "closed") return;
    this.finish(code);
    const other = socket === this.phone ? this.data : this.phone;
    if (other) closeWith(this.ctx, other, PASS_THROUGH_CODES.has(code) ? code : 1001);
  }

  private finish(code: number): void {
    this.state = "closed";
    clearTimeout(this.openTimer);
    for (const dir of [this.toHost, this.toPhone]) clearTimeout(dir?.wedge);
    for (const timer of this.throttleTimers) clearTimeout(timer);
    this.throttleTimers.clear();
    this.entry.sessions.delete(this.sid);
    this.ctx.hosts.release(this.entry);
    this.ctx.log({
      ev: "session",
      hid8: this.entry.hid8,
      dur_s: Math.round((this.ctx.now() - this.started) / 1000),
      up: this.up,
      down: this.down,
      close: code,
    });
  }
}
