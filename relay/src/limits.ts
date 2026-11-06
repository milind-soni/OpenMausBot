import { isIPv4, isIPv6 } from "node:net";

/** Caddy runs on the same host and is the only peer allowed to name the client in X-Forwarded-For. */
const TRUSTED_PROXY = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

/**
 * The key a client's per-IP limits are counted under, or undefined when a trusted proxy sent an X-Forwarded-For that is
 * not an address. The last entry is the one the proxy itself appended, so earlier entries a client wrote are ignored.
 * Anyone but the proxy is counted by its own address and its X-Forwarded-For is ignored.
 */
export function clientKey(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string | undefined {
  if (!remoteAddress) return undefined;
  if (!TRUSTED_PROXY.has(remoteAddress)) return addressKey(remoteAddress);
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (header === undefined) return addressKey(remoteAddress);
  const last = header.slice(header.lastIndexOf(",") + 1).trim();
  return isIPv4(last) || isIPv6(last) ? addressKey(last) : undefined;
}

/** IPv4 by address. IPv6 by /64, because one client is routinely given a whole /64 and could rotate within it. */
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIPv4(address)) return address;
  const groups = expandIPv6(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
}

function expandIPv6(address: string): string[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  return [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((group) => group.padStart(4, "0"));
}

/** A token bucket that starts full: `capacity` tokens, refilled at `perMs` tokens a millisecond. */
export class TokenBucket {
  private readonly capacity: number;
  private readonly perMs: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;

  constructor(capacity: number, perMs: number, now: () => number) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  /** Takes `count` tokens when that many are there. */
  take(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Takes `count` tokens even into debt, and says how long until the bucket is out of debt (0 when it is not in debt). */
  spend(count: number): number {
    this.refill();
    this.tokens -= count;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens / this.perMs);
  }

  get full(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
  }
}

export type IpVerdict = "ok" | "rate" | "open";

interface IpEntry {
  bucket: TokenBucket;
  open: number;
}

/** New sockets a minute and open sockets, per client key. Entries live only in memory and are swept once idle. */
export class IpLimiter {
  private readonly entries = new Map<string, IpEntry>();
  private readonly newPerMinute: number;
  private readonly openMax: number;
  private readonly now: () => number;

  constructor(newPerMinute: number, openMax: number, now: () => number) {
    this.newPerMinute = newPerMinute;
    this.openMax = openMax;
    this.now = now;
  }

  /** Counts a new socket for `key` when its limits allow one; the caller must `release` it when the socket closes. */
  admit(key: string): IpVerdict {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.newPerMinute, this.newPerMinute / 60_000, this.now), open: 0 };
      this.entries.set(key, entry);
    }
    if (entry.open >= this.openMax) return "open";
    if (!entry.bucket.take()) return "rate";
    entry.open += 1;
    return "ok";
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.open > 0) entry.open -= 1;
  }

  /** Forgets keys with no open sockets and a full bucket: they would behave exactly like a new key. */
  sweep(): void {
    for (const [key, entry] of this.entries) {
      if (entry.open === 0 && entry.bucket.full) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
