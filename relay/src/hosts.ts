import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import type { Context } from "./context.ts";
import { hid8 } from "./log.ts";
import { afterFirstMessage, closeWith, sendJson, type MessageHandler } from "./socket.ts";
import type { Session } from "./splice.ts";
import { TokenBucket } from "./limits.ts";
import { verifyToken, type TokenResult } from "./token.ts";
import { Close, parseAdmit, parseAuth, parseData, parseObject } from "./wire.ts";

const NO_MATCH = Buffer.alloc(32);

/**
 * One host on this node. It lives while it has a control socket or a session, and goes with the last of them, so no
 * routing state can outlive the sockets it describes.
 */
export class HostEntry {
  readonly hid: Buffer;
  readonly hidText: string;
  readonly hid8: string;
  control: WebSocket | undefined;
  /** SHA256(adm) of every phone the current control socket admits; empty without a control socket. */
  admission: Buffer[] = [];
  readonly sessions = new Map<string, Session>();

  constructor(hid: Buffer, hidText: string) {
    this.hid = hid;
    this.hidText = hidText;
    this.hid8 = hid8(hid);
  }
}

export class Hosts {
  private readonly entries = new Map<string, HostEntry>();
  private readonly slots: number;
  connected = 0;
  /** Sessions spliced right now, across every host. */
  spliced = 0;

  constructor(admissionMax: number) {
    this.slots = admissionMax;
  }

  get(hidText: string): HostEntry | undefined {
    return this.entries.get(hidText);
  }

  entry(hid: Buffer, hidText: string): HostEntry {
    let entry = this.entries.get(hidText);
    if (!entry) {
      entry = new HostEntry(hid, hidText);
      this.entries.set(hidText, entry);
    }
    return entry;
  }

  release(entry: HostEntry): void {
    if (!entry.control && entry.sessions.size === 0 && this.entries.get(entry.hidText) === entry) this.entries.delete(entry.hidText);
  }

  /**
   * Whether a connected host admits `admHash`. Every slot is compared in full and in constant time whether or not the
   * host exists, so neither the answer's timing nor the close code tells a phone that a host is online.
   */
  admitted(entry: HostEntry | undefined, admHash: Buffer): boolean {
    const set = entry?.control ? entry.admission : [];
    let found = 0;
    for (let i = 0; i < this.slots; i++) {
      const equal = timingSafeEqual(set[i] ?? NO_MATCH, admHash) ? 1 : 0;
      found |= equal & (i < set.length ? 1 : 0);
    }
    return found === 1;
  }

  get size(): number {
    return this.entries.size;
  }

  *all(): IterableIterator<HostEntry> {
    yield* this.entries.values();
  }
}

interface Budget {
  day: number;
  bytes: number;
}

/** Bytes each host relayed today (UTC). Kept apart from HostEntry so reconnecting does not reset a host's count. */
export class HostBudgets {
  private readonly budgets = new Map<string, Budget>();
  private readonly limit: number;
  private readonly today: () => number;

  constructor(limit: number, wallSeconds: () => number) {
    this.limit = limit;
    this.today = () => Math.floor(wallSeconds() / 86_400);
  }

  /** Adds `bytes` to the host's day and says whether this addition took it over the limit. */
  add(hidText: string, bytes: number): boolean {
    const day = this.today();
    let budget = this.budgets.get(hidText);
    if (!budget || budget.day !== day) {
      budget = { day, bytes: 0 };
      this.budgets.set(hidText, budget);
    }
    const before = budget.bytes;
    budget.bytes += bytes;
    return before <= this.limit && budget.bytes > this.limit;
  }

  over(hidText: string): boolean {
    const budget = this.budgets.get(hidText);
    return budget !== undefined && budget.day === this.today() && budget.bytes > this.limit;
  }

  sweep(): void {
    const day = this.today();
    for (const [hidText, budget] of this.budgets) if (budget.day !== day) this.budgets.delete(hidText);
  }
}

function checkToken(ctx: Context, token: string, expectHid?: string): TokenResult {
  const result = verifyToken(token, ctx.tokenKeys, ctx.wallSeconds(), expectHid);
  if (!result.ok) ctx.metrics.inc("relay_token_rejected_total", result.reason);
  return result;
}

/** Closes every session of `entry` whose phone the current admission set no longer holds. */
function enforceAdmission(ctx: Context, entry: HostEntry): void {
  for (const session of entry.sessions.values()) {
    if (!ctx.hosts.admitted(entry, session.admHash)) session.end(Close.NotFound);
  }
}

/** `GET /v1/host`: auth, `hello`, the admission set, `open` for each waiting phone, token refresh and expiry. */
export function handleControl(ctx: Context, ws: WebSocket): void {
  afterFirstMessage(ctx, ws, (message) => {
    const token = parseAuth(message);
    if (token === undefined) return void closeWith(ctx, ws, Close.Malformed);
    const verified = checkToken(ctx, token);
    if (!verified.ok) return void closeWith(ctx, ws, Close.TokenInvalid);

    const entry = ctx.hosts.entry(verified.claims.hid, verified.claims.hidText);
    const previous = entry.control;
    entry.control = ws;
    entry.admission = [];
    if (previous) closeWith(ctx, previous, Close.Replaced);
    else ctx.metrics.peak("hosts_connected", (ctx.hosts.connected += 1));

    const since = ctx.now();
    const rate = new TokenBucket(ctx.limits.controlBurst, ctx.limits.controlPerSecond / 1000, ctx.now);
    let expires = verified.claims.exp;
    let admitted = false;
    let expiry: NodeJS.Timeout | undefined;
    const armExpiry = () => {
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        if (ctx.wallSeconds() >= expires) closeWith(ctx, ws, Close.TokenInvalid);
        else armExpiry();
      }, Math.max(0, expires * 1000 - ctx.wallSeconds() * 1000));
    };
    armExpiry();
    const admitDeadline = setTimeout(() => {
      if (!admitted) closeWith(ctx, ws, Close.Malformed);
    }, ctx.limits.admitDeadlineMs);

    ctx.heartbeat.track(ws);
    ws.once("close", (code) => {
      clearTimeout(expiry);
      clearTimeout(admitDeadline);
      if (entry.control === ws) {
        entry.control = undefined;
        entry.admission = [];
        ctx.hosts.connected -= 1;
      }
      ctx.hosts.release(entry);
      ctx.log({ ev: "host", hid8: entry.hid8, dur_s: Math.round((ctx.now() - since) / 1000), close: code });
    });
    sendJson(ws, { t: "hello", v: 1, node: ctx.node, sessionsMax: ctx.limits.hostSessionsMax });

    const handler: MessageHandler = (data, isBinary) => {
      ctx.heartbeat.mark(ws);
      if (entry.control !== ws) return;
      if (!rate.take()) return closeWith(ctx, ws, Close.Limited);
      const next = !isBinary && data.length <= ctx.limits.authMessageBytes ? parseObject(data.toString("utf8")) : undefined;
      if (next?.t === "auth") {
        const refresh = parseAuth(next);
        if (refresh === undefined) return closeWith(ctx, ws, Close.Malformed);
        const renewed = checkToken(ctx, refresh, entry.hidText);
        if (!renewed.ok) return closeWith(ctx, ws, Close.TokenInvalid);
        expires = renewed.claims.exp;
        armExpiry();
        return sendJson(ws, { t: "hello", v: 1, node: ctx.node, sessionsMax: ctx.limits.hostSessionsMax });
      }
      const set = next ? parseAdmit(next, ctx.limits.admissionMax) : undefined;
      if (!set) return closeWith(ctx, ws, Close.Malformed);
      entry.admission = set;
      admitted = true;
      clearTimeout(admitDeadline);
      enforceAdmission(ctx, entry);
    };
    return handler;
  });
}

/** `GET /v1/host/data`: claims one waiting phone's `sid` for the token's host and splices the two sockets. */
export function handleData(ctx: Context, ws: WebSocket): void {
  afterFirstMessage(ctx, ws, (message) => {
    const claim = parseData(message);
    if (!claim) return void closeWith(ctx, ws, Close.Malformed);
    const verified = checkToken(ctx, claim.token);
    if (!verified.ok) return void closeWith(ctx, ws, Close.TokenInvalid);
    const session = ctx.hosts.get(verified.claims.hidText)?.sessions.get(claim.sid);
    if (!session || session.state !== "pending") return void closeWith(ctx, ws, Close.NotFound);
    session.splice(ws);
    return (data, isBinary) => session.fromHost(data, isBinary);
  });
}
