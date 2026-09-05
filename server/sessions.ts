// Pairing codes, sessions and stream tickets for clients that are not on
// this machine. The shape the iOS companion already proved (short-lived
// pairing → durable per-device credential, hashed at rest), generalized.
//
// A pairing code is 12 characters from a 32-symbol alphabet with no 0/O/1/I
// (60 bits), single use, five minutes. Exchanging it yields an opaque
// session token (`omb_sess_…`, 256 bits) that lives 30 days; only its sha256
// is stored. A stream ticket is a 5-minute single-use credential for the SSE
// endpoint, because EventSource cannot set headers. Failed exchanges are
// counted per source: five in a minute lock that source out for ten.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export type Scope = "admin" | "client";
export const SCOPES: readonly Scope[] = ["admin", "client"];

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const STREAM_TICKET_TTL_MS = 5 * 60_000;
/** Per-source slow-down only. A 60-bit code cannot be guessed online in
 * five minutes whatever the rate, so the lock exists to make noise visible,
 * not to protect the secret; it is kept short because sources are shared
 * (an office NAT, a proxy) and a long lock would let one bad neighbour keep
 * everyone else from pairing. */
export const LOCKOUT = { failures: 10, windowMs: 60_000, lockMs: 60_000 } as const;
/** A consumed code presented again with the SAME attempt id within this
 * window gets the same answer, so a lost response does not strand the
 * device. The attempt id is a random value the client made up for that one
 * attempt: without it there is no replay, and sharing an address with the
 * device is not enough to obtain its token. */
export const EXCHANGE_REPLAY_MS = 60_000;
/** Outstanding stream tickets per session; issuing more retires the oldest. */
export const MAX_STREAM_TICKETS_PER_SESSION = 5;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

const scopeSchema = z.enum(["admin", "client"]);

const sessionSchema = z.object({
  id: z.string().min(1),
  tokenHash: z.string().length(64),
  label: z.string().max(80),
  scopes: z.array(scopeSchema).min(1),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number(),
});

const fileSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) });

export type SessionRecord = z.infer<typeof sessionSchema>;

/** What the UI may see: never the hash. */
export interface PublicSession {
  id: string;
  label: string;
  scopes: Scope[];
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface PairingCode {
  id: string;
  codeHash: string;
  scopes: Scope[];
  label: string;
  createdAt: number;
  expiresAt: number;
}

export interface PublicPairing {
  id: string;
  label: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number;
}

export type ExchangeResult =
  | { ok: true; token: string; session: PublicSession }
  | { ok: false; status: 401 | 429; error: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 12 symbols, rejection-sampled so every symbol is equally likely. */
export function generatePairingCode(): string {
  const limit = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

/** Accept what a human typed: dashes, spaces, lowercase, lookalikes. */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

/** XXXX-XXXX-XXXX, easier to read out loud. */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function publicSession(record: SessionRecord): PublicSession {
  return {
    id: record.id,
    label: record.label,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
  };
}

export class SessionRegistry {
  private sessions: SessionRecord[] = [];
  private pairings: PairingCode[] = [];
  private tickets = new Map<string, { sessionId: string; expiresAt: number }>();
  private failures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
  private replays: Array<{ codeHash: string; attemptId: string; result: ExchangeResult; expiresAt: number }> = [];
  private readonly onRevoked = new Set<(sessionId: string) => void>();
  private lastSeenWrites = new Map<string, number>();
  private readonly now: () => number;
  private readonly options: { file: string; now?: () => number };

  // No parameter properties: the server runs this file under Node's
  // strip-only TypeScript mode, which only erases types.
  constructor(options: { file: string; now?: () => number }) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.options.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.file, "utf8"));
    } catch {
      return; // unreadable: start empty rather than refuse to boot; pairing again is cheap
    }
    const parsed = fileSchema.safeParse(raw);
    if (parsed.success) this.sessions = parsed.data.sessions;
  }

  /** Atomic write, owner-only, directory owner-only. */
  private persist(): void {
    const dir = dirname(this.options.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.options.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.sessions }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.options.file);
  }

  private prune(): void {
    const now = this.now();
    this.pairings = this.pairings.filter((p) => p.expiresAt > now);
    this.replays = this.replays.filter((r) => r.expiresAt > now);
    for (const [hash, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(hash);
    for (const [source, entry] of this.failures) {
      if (entry.lockedUntil <= now && now - entry.windowStart > LOCKOUT.windowMs) this.failures.delete(source);
    }
    const expired = this.sessions.filter((s) => s.expiresAt <= now);
    if (expired.length) {
      this.sessions = this.sessions.filter((s) => s.expiresAt > now);
      for (const s of expired) this.forget(s.id);
      this.persist();
    }
  }

  /** Called with a session id whenever it stops being valid (revoked,
   * logged out, expired), so open streams can be closed. */
  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.onRevoked.add(listener);
    return () => this.onRevoked.delete(listener);
  }

  private forget(sessionId: string): void {
    this.lastSeenWrites.delete(sessionId);
    for (const [hash, ticket] of this.tickets) if (ticket.sessionId === sessionId) this.tickets.delete(hash);
    for (const listener of this.onRevoked) listener(sessionId);
  }

  // ── pairing ────────────────────────────────────────────────────────────

  openPairing(input: { scopes?: Scope[]; label?: string; ttlMs?: number } = {}): { id: string; code: string; expiresAt: number } {
    this.prune();
    const now = this.now();
    const code = generatePairingCode();
    const scopes = input.scopes?.length ? [...new Set(input.scopes)] : [...SCOPES];
    const pairing: PairingCode = {
      id: randomUUID(),
      codeHash: sha256(code),
      scopes,
      label: (input.label ?? "").trim().slice(0, 80),
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? PAIRING_CODE_TTL_MS),
    };
    this.pairings.push(pairing);
    return { id: pairing.id, code, expiresAt: pairing.expiresAt };
  }

  openPairings(): PublicPairing[] {
    this.prune();
    return this.pairings.map((p) => ({ id: p.id, label: p.label, scopes: [...p.scopes], createdAt: p.createdAt, expiresAt: p.expiresAt }));
  }

  cancelPairing(id: string): boolean {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((p) => p.id !== id);
    return this.pairings.length !== before;
  }

  /** Sources with recent failures (for tests and diagnostics; never the codes). */
  failureSources(): string[] {
    this.prune();
    return [...this.failures.keys()];
  }

  private lockState(source: string): { locked: boolean; retryAfterMs: number } {
    const entry = this.failures.get(source);
    if (!entry) return { locked: false, retryAfterMs: 0 };
    const now = this.now();
    if (entry.lockedUntil > now) return { locked: true, retryAfterMs: entry.lockedUntil - now };
    return { locked: false, retryAfterMs: 0 };
  }

  private recordFailure(source: string): void {
    const now = this.now();
    const entry = this.failures.get(source) ?? { count: 0, windowStart: now, lockedUntil: 0 };
    if (now - entry.windowStart > LOCKOUT.windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    if (entry.count >= LOCKOUT.failures) {
      entry.lockedUntil = now + LOCKOUT.lockMs;
      entry.count = 0;
      entry.windowStart = now;
    }
    this.failures.set(source, entry);
  }

  /** Turn a pairing code into a session. `source` identifies the caller for
   * the lockout (an IP); `label` names the device in the sessions list. */
  /** `label` is what the client asked to be called; the code's own label
   * (set by whoever minted it) comes next; `fallbackLabel` (derived from the
   * user agent) last. */
  exchange(input: { code: string; label: string; source: string; fallbackLabel?: string; attemptId?: string }): ExchangeResult {
    this.prune();
    const now = this.now();
    const presented = sha256(normalizePairingCode(input.code));
    const attemptId = typeof input.attemptId === "string" && /^[\w-]{8,64}$/.test(input.attemptId) ? input.attemptId : null;
    const replay = attemptId ? this.replays.find((r) => r.attemptId === attemptId && sameDigest(r.codeHash, presented)) : undefined;
    if (replay) return replay.result;
    const lock = this.lockState(input.source);
    if (lock.locked) {
      const seconds = Math.ceil(lock.retryAfterMs / 1000);
      return { ok: false, status: 429, error: `too many failed pairing attempts from your address; try again in ${seconds}s` };
    }
    const index = this.pairings.findIndex((p) => sameDigest(p.codeHash, presented));
    if (index < 0) {
      this.recordFailure(input.source);
      return { ok: false, status: 401, error: "pairing code is wrong or has expired; create a new one on the server" };
    }
    const [pairing] = this.pairings.splice(index, 1); // single use
    this.failures.delete(input.source);
    const token = `omb_sess_${randomBytes(32).toString("base64url")}`;
    const record: SessionRecord = {
      id: randomUUID(),
      tokenHash: sha256(token),
      label: (input.label.trim() || pairing.label || input.fallbackLabel?.trim() || "Unnamed device").slice(0, 80),
      scopes: [...pairing.scopes],
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.push(record);
    this.lastSeenWrites.set(record.id, now); // the exchange itself was the first sighting
    this.persist();
    const result: ExchangeResult = { ok: true, token, session: publicSession(record) };
    if (attemptId) this.replays.push({ codeHash: presented, attemptId, result, expiresAt: now + EXCHANGE_REPLAY_MS });
    return result;
  }

  // ── sessions ───────────────────────────────────────────────────────────

  authenticate(token: string | undefined): SessionRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const now = this.now();
    const record = this.sessions.find((s) => sameDigest(s.tokenHash, hash));
    if (!record || record.expiresAt <= now) return null;
    const lastWrite = this.lastSeenWrites.get(record.id) ?? 0;
    if (now - lastWrite >= LAST_SEEN_WRITE_INTERVAL_MS) {
      record.lastSeenAt = now;
      this.lastSeenWrites.set(record.id, now);
      this.persist();
    }
    return record;
  }

  /** Still valid right now (prunes expiry first). */
  isLive(sessionId: string): boolean {
    this.prune();
    return this.sessions.some((s) => s.id === sessionId);
  }

  list(): PublicSession[] {
    this.prune();
    return this.sessions.map(publicSession);
  }

  revoke(id: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    this.forget(id);
    this.persist();
    return true;
  }

  // ── stream tickets ─────────────────────────────────────────────────────

  issueStreamTicket(sessionId: string): { ticket: string; expiresAt: number } {
    this.prune();
    const mine = [...this.tickets].filter(([, t]) => t.sessionId === sessionId).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - (MAX_STREAM_TICKETS_PER_SESSION - 1)))) this.tickets.delete(hash);
    const ticket = `omb_tick_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + STREAM_TICKET_TTL_MS;
    this.tickets.set(sha256(ticket), { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /** Single use: a reconnecting client asks for a fresh ticket first. */
  redeemStreamTicket(ticket: string): SessionRecord | null {
    this.prune();
    const hash = sha256(ticket);
    const entry = this.tickets.get(hash);
    if (!entry) return null;
    this.tickets.delete(hash);
    const now = this.now();
    const record = this.sessions.find((s) => s.id === entry.sessionId);
    return record && record.expiresAt > now ? record : null;
  }
}
