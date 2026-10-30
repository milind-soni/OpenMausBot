// Pairing codes (60-bit, single use, 5 min), sessions (256-bit, only the sha256 stored) and stream tickets (EventSource cannot set headers).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { teamSessionExpiresAt, type TeamMember, type TeamRole } from "./cloud-team.ts";

export type Scope = "admin" | "client";
export const SCOPES: readonly Scope[] = ["admin", "client"];

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** Not clamped: an invalid value falls back to the default, so a typo never becomes a policy. */
export function daysMs(value: string | undefined, fallbackDays: number): number {
  const days = Number(value);
  const ok = Number.isInteger(days) && days >= 1 && days <= 3650;
  return (ok ? days : fallbackDays) * 24 * 60 * 60_000;
}
/** OMB_SESSION_TTL_DAYS (default 30): a session used with half its term or less left renews for the full term. */
export const SESSION_TTL_MS = daysMs(process.env.OMB_SESSION_TTL_DAYS, 30);
/** OMB_SESSION_MAX_DAYS (default 180): renewal never passes this, so a stolen cookie has a bounded life. */
export const SESSION_MAX_AGE_MS = daysMs(process.env.OMB_SESSION_MAX_DAYS, 180);
export const SESSION_RENEW_WHEN_LEFT_MS = SESSION_TTL_MS / 2;

export function cookieMaxAgeSeconds(session: { expiresAt: number }, now = Date.now()): number {
  return Math.max(1, Math.floor((session.expiresAt - now) / 1000));
}
export const STREAM_TICKET_TTL_MS = 5 * 60_000;
/** Slow-down only: a 60-bit code cannot be guessed online in five minutes, and sources are shared (NAT), so the lock stays short. */
export const LOCKOUT = { failures: 10, windowMs: 60_000, lockMs: 60_000 } as const;
/** A consumed code re-presented with the same client-made attempt id gets the same answer; sharing an address is not enough. */
export const EXCHANGE_REPLAY_MS = 60_000;
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
  userId: z.string().max(256).optional(),
  email: z.string().max(320).optional(),
  /** `portal`: set only by the internal verified-portal issuance path. `team`: the Admin's signed member claim on a
   * Team Cloud. Never by email or pairing input. */
  membershipAuthority: z.enum(["portal", "team"]).optional(),
  /** A Team Cloud session's role in the team, from the Admin's claim. */
  teamRole: z.enum(["owner", "admin", "member"]).optional(),
  /** A team session opened with a code its member made (their phone): when the Admin last vouched for that member. The
   * session ends within the hour of it; each new Admin-signed pairing of the same member, in the same role, moves it. */
  memberCheckedAt: z.number().optional(),
  /** A browser sign-in (PairingCode `browser`): accepted only as its browser's cookie, never as a bearer token. */
  cookieOnly: z.literal(true).optional(),
  owner: z.string().max(254).optional(),
  /** A Team Cloud's sign-in for moving one bot in (server/team-move-in.ts): it reaches that bot's move routes only. */
  moveIn: z.string().regex(/^[\w-]{1,128}$/).optional(),
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
  email?: string;
  owner?: string;
  teamRole?: TeamRole;
}

export interface PairingCode {
  id: string;
  codeHash: string;
  credentialHash: string;
  scopes: Scope[];
  label: string;
  createdAt: number;
  expiresAt: number;
  /** Only a browser sign-in redeems it, only by its credential, and a browser sign-in redeems no other window. */
  browser?: true;
  owner?: string;
  /** A Team Cloud's pairing: the Admin's signed member claim, bound to the session it opens. */
  member?: TeamMember;
  /** A code a member made from their own session: when the Admin last vouched for them. Absent on the Admin's own. */
  memberCheckedAt?: number;
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
  | { ok: false; status: 401 | 403 | 429; error: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function deviceLabel(value: string | undefined): string {
  return (value ?? "").replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
}

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

/** A credential is matched byte for byte; only a typed code is normalized. */
export const PAIRING_CREDENTIAL_PREFIX = "omb_pair_";

/** 9 + 43 characters: the Android companion checks that length exactly. */
export function generatePairingCredential(): string {
  return `${PAIRING_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isPairingCredential(value: string): boolean {
  return value.startsWith(PAIRING_CREDENTIAL_PREFIX);
}

export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function publicSession(record: SessionRecord): PublicSession {
  const view: PublicSession = {
    id: record.id,
    label: record.label,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
  };
  if (record.email) view.email = record.email;
  if (record.owner) view.owner = record.owner;
  if (record.teamRole) view.teamRole = record.teamRole;
  return view;
}

export type EmailScopesResolver = (email: string) => readonly Scope[] | null;
export interface SessionStoreOptions {
  file: string;
  now?: () => number;
  emailScopes?: EmailScopesResolver;
  emailScopesSnapshot?: () => EmailScopesResolver;
  portalMembership?: boolean;
}

export class SessionRegistry {
  private sessions: SessionRecord[] = [];
  private pairings: PairingCode[] = [];
  private tickets = new Map<string, { sessionId: string; expiresAt: number }>();
  private failures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
  private replays: Array<{ codeHash: string; attemptId: string; browser: boolean; result: ExchangeResult; expiresAt: number }> = [];
  private readonly onRevoked = new Set<(sessionId: string) => void>();
  private readonly onIssued = new Set<(session: Pick<SessionRecord, "id" | "scopes" | "email" | "teamRole" | "membershipAuthority">) => void>();
  private lastSeenWrites = new Map<string, number>();
  private readonly now: () => number;
  private readonly options: SessionStoreOptions;
  private readonly openMarker: string;
  private closed = false;
  private adminOnly: string | null = null;

  // No parameter properties: Node's strip-only TypeScript mode only erases types.
  constructor(options: SessionStoreOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.openMarker = `${options.file}.open`;
    const unclean = existsSync(this.openMarker);
    try {
      mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
      // Write the guard before accepting any persisted bearer, so an unclean restart sees it.
      writeFileAtomic(this.openMarker, "Session registry is open.\n", { mode: 0o600 });
      this.syncDirectory();
    } catch {
      throw new Error("Could not establish safe session storage.");
    }
    this.load(!unclean);
    this.revalidateEmailSessions();
  }

  private load(restoreAccounts: boolean): void {
    if (!existsSync(this.options.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.file, "utf8"));
    } catch {
      return;
    }
    const parsed = fileSchema.safeParse(raw);
    if (parsed.success) this.sessions = parsed.data.sessions.filter(session => restoreAccounts || (session.email === undefined && session.userId === undefined));
  }

  private syncDirectory(): void {
    // Windows exposes no directory fsync: no power-loss guarantee is claimed there.
    if (process.platform === "win32") return;
    const fd = openSync(dirname(this.options.file), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  /** Atomic write, owner-only, directory owner-only. */
  private persist(): void {
    if (this.closed) throw new Error("Session registry is closed.");
    const dir = dirname(this.options.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, sessions: this.sessions }, null, 2) + "\n", { mode: 0o600 });
    this.syncDirectory();
  }

  /** Call after HTTP/stream shutdown. Never remove the open marker before the reduced set is saved. */
  close(): void {
    if (this.closed) return;
    try {
      this.revalidateEmailSessions();
      this.persist();
      unlinkSync(this.openMarker);
      this.closed = true;
    } catch {
      throw new Error("Could not safely close session storage.");
    }
  }

  private prune(): void {
    this.revalidateEmailSessions();
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

  /** Every session opened from now on, by pairing or sign-in. */
  onSessionIssued(listener: (session: Pick<SessionRecord, "id" | "scopes" | "email" | "teamRole" | "membershipAuthority">) => void): () => void {
    this.onIssued.add(listener);
    return () => this.onIssued.delete(listener);
  }

  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.onRevoked.add(listener);
    return () => this.onRevoked.delete(listener);
  }

  private forget(sessionId: string): void {
    this.lastSeenWrites.delete(sessionId);
    for (const [hash, ticket] of this.tickets) if (ticket.sessionId === sessionId) this.tickets.delete(hash);
    for (const listener of this.onRevoked) listener(sessionId);
  }

  /** From now on nothing without admin scope is opened, redeemed, issued or accepted; the caller revokes stored sessions. */
  requireAdmin(refusal: string): void {
    this.adminOnly = refusal;
  }

  private personal(scopes: readonly Scope[]): boolean {
    return this.adminOnly !== null && !scopes.includes("admin");
  }

  private refusePersonal(scopes: readonly Scope[]): void {
    if (this.personal(scopes)) throw Object.assign(new Error(this.adminOnly!), { status: 403, code: "cloud_personal" });
  }

  openPairing(input: { scopes?: Scope[]; label?: string; ttlMs?: number; browser?: boolean; owner?: string; member?: TeamMember; memberCheckedAt?: number } = {}): { id: string; code: string; credential: string; expiresAt: number } {
    this.prune();
    const now = this.now();
    const code = generatePairingCode();
    const credential = generatePairingCredential();
    const scopes = input.scopes?.length ? [...new Set(input.scopes)] : [...SCOPES];
    this.refusePersonal(scopes);
    const pairing: PairingCode = {
      id: randomUUID(),
      codeHash: sha256(code),
      credentialHash: sha256(credential),
      scopes,
      label: (input.label ?? "").trim().slice(0, 80),
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? PAIRING_CODE_TTL_MS),
      ...(input.browser ? { browser: true as const, ...(input.owner ? { owner: input.owner } : {}) } : {}),
      ...(input.member ? { member: input.member, ...(input.memberCheckedAt !== undefined ? { memberCheckedAt: input.memberCheckedAt } : {}) } : {}),
    };
    this.pairings.push(pairing);
    return { id: pairing.id, code, credential, expiresAt: pairing.expiresAt };
  }

  openPairings(): PublicPairing[] {
    this.prune();
    return this.pairings.map((p) => ({ id: p.id, label: p.label, scopes: [...p.scopes], createdAt: p.createdAt, expiresAt: p.expiresAt }));
  }

  /** Only a browser sign-in's 256-bit credential matches, so this consumes nothing and counts toward no lockout. */
  previewBrowserSignIn(credential: string): { owner: string | null; expiresAt: number } | null {
    this.prune();
    if (!isPairingCredential(credential)) return null;
    const presented = sha256(credential);
    const pairing = this.pairings.find((p) => p.browser === true && sameDigest(p.credentialHash, presented));
    return pairing ? { owner: pairing.owner ?? null, expiresAt: pairing.expiresAt } : null;
  }

  cancelPairing(id: string): boolean {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((p) => p.id !== id);
    return this.pairings.length !== before;
  }

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

  exchange(input: { code: string; label: string; source: string; fallbackLabel?: string; attemptId?: string; browser?: boolean }): ExchangeResult {
    this.prune();
    const now = this.now();
    // Hashed as presented: normalizePairingCode folds 0 to O and 1 to I, which would merge distinct secrets.
    const presented = isPairingCredential(input.code)
      ? sha256(input.code)
      : sha256(normalizePairingCode(input.code));
    const browser = input.browser === true;
    const attemptId = typeof input.attemptId === "string" && /^[\w-]{8,64}$/.test(input.attemptId) ? input.attemptId : null;
    const replay = attemptId ? this.replays.find((r) => r.attemptId === attemptId && r.browser === browser && sameDigest(r.codeHash, presented)) : undefined;
    if (replay) return replay.result;
    const lock = this.lockState(input.source);
    if (lock.locked) {
      const seconds = Math.ceil(lock.retryAfterMs / 1000);
      return { ok: false, status: 429, error: `too many failed pairing attempts from your address; try again in ${seconds}s` };
    }
    const index = this.pairings.findIndex((p) => (p.browser === true) === browser &&
      (sameDigest(p.credentialHash, presented) || (!p.browser && sameDigest(p.codeHash, presented))));
    if (index < 0) {
      this.recordFailure(input.source);
      return { ok: false, status: 401, error: "pairing code is wrong or has expired; create a new one on the server" };
    }
    const [pairing] = this.pairings.splice(index, 1);
    this.failures.delete(input.source);
    if (this.personal(pairing.scopes)) return { ok: false, status: 403, error: this.adminOnly! };
    const token = `omb_sess_${randomBytes(32).toString("base64url")}`;
    const checkedAt = pairing.memberCheckedAt ?? now;
    const record: SessionRecord = {
      id: randomUUID(),
      tokenHash: sha256(token),
      label: (deviceLabel(input.label) || deviceLabel(pairing.label) || deviceLabel(input.fallbackLabel) || "Unnamed device").slice(0, 80),
      scopes: [...pairing.scopes],
      createdAt: now,
      lastSeenAt: now,
      expiresAt: pairing.member ? teamSessionExpiresAt(checkedAt, now + SESSION_TTL_MS) : now + Math.min(SESSION_TTL_MS, SESSION_MAX_AGE_MS),
      ...(pairing.browser ? { cookieOnly: true as const, ...(pairing.owner ? { owner: pairing.owner } : {}) } : {}),
      ...(pairing.member ? { email: pairing.member.email, teamRole: pairing.member.role, membershipAuthority: "team" as const } : {}),
      ...(pairing.member && pairing.memberCheckedAt !== undefined ? { memberCheckedAt: pairing.memberCheckedAt } : {}),
    };
    if (pairing.member && pairing.memberCheckedAt === undefined) this.memberChecked(pairing.member, now);
    this.sessions.push(record);
    this.lastSeenWrites.set(record.id, now);
    this.persist();
    for (const listener of this.onIssued) listener(record);
    const result: ExchangeResult = { ok: true, token, session: publicSession(record) };
    if (attemptId) this.replays.push({ codeHash: presented, attemptId, browser, result, expiresAt: now + EXCHANGE_REPLAY_MS });
    return result;
  }

  /** The Admin vouched for a member just now: the sessions their own codes opened (their phones) live on another hour.
   * One whose role changed since is left to end. */
  private memberChecked(member: TeamMember, now: number): void {
    for (const session of this.sessions) {
      if (session.memberCheckedAt === undefined || session.membershipAuthority !== "team" || session.email !== member.email || session.teamRole !== member.role || session.expiresAt <= now) continue;
      session.memberCheckedAt = now;
      session.expiresAt = Math.max(session.expiresAt, teamSessionExpiresAt(now, Math.min(now + SESSION_TTL_MS, session.createdAt + SESSION_MAX_AGE_MS)));
    }
  }

  issue(input: { label: string; scopes: Scope[]; userId?: string; email?: string }): { token: string; session: PublicSession } {
    return this.issueAccount(input);
  }

  /** The one sign-in that moves `bot` in for this team member, as long-lived as their own team session. Only the caller's
   * own team session may ask for it (server/team-move-in.ts). */
  issueMoveIn(input: { label: string; email: string; teamRole: TeamRole; bot: string }): { token: string; session: PublicSession } {
    this.prune();
    const now = this.now();
    const token = `omb_sess_${randomBytes(32).toString("base64url")}`;
    const record: SessionRecord = {
      id: randomUUID(), tokenHash: sha256(token), label: (deviceLabel(input.label) || "Moving a bot in").slice(0, 80), scopes: ["admin", "client"],
      createdAt: now, lastSeenAt: now, expiresAt: teamSessionExpiresAt(now, now + SESSION_TTL_MS),
      email: input.email, teamRole: input.teamRole, membershipAuthority: "team", moveIn: input.bot,
    };
    this.sessions.push(record);
    this.lastSeenWrites.set(record.id, now);
    this.persist();
    for (const listener of this.onIssued) listener(record);
    return { token, session: publicSession(record) };
  }

  /** Ends every sign-in that moves `bot` in: the bot arrived. */
  revokeMoveIns(bot: string): number {
    const ended = this.sessions.filter((s) => s.moveIn === bot);
    if (!ended.length) return 0;
    this.sessions = this.sessions.filter((s) => s.moveIn !== bot);
    for (const s of ended) this.forget(s.id);
    this.persist();
    return ended.length;
  }

  /** Call only after consuming a verified, workspace-bound PKCE grant; no HTTP route accepts this marker as input. */
  issuePortal(input: { email: string; grant: string; scopes: Scope[] }): { token: string; session: PublicSession } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.grant) || !input.email) throw new Error("A verified portal identity is required");
    return this.issueAccount({ label: "Hosted workspace", email: input.email, userId: `portal:${input.grant}`, scopes: input.scopes }, "portal");
  }

  private issueAccount(input: { label: string; scopes: Scope[]; userId?: string; email?: string }, membershipAuthority?: "portal"): { token: string; session: PublicSession } {
    this.refusePersonal(input.scopes);
    this.prune();
    const now = this.now();
    const token = `omb_sess_${randomBytes(32).toString("base64url")}`;
    const record: SessionRecord = {
      id: randomUUID(),
      tokenHash: sha256(token),
      label: (deviceLabel(input.label) || "Unnamed device").slice(0, 80),
      scopes: [...new Set(input.scopes)],
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + Math.min(SESSION_TTL_MS, SESSION_MAX_AGE_MS),
    };
    if (input.userId) record.userId = input.userId;
    if (input.email) record.email = input.email;
    if (membershipAuthority) record.membershipAuthority = membershipAuthority;
    this.sessions.push(record);
    this.lastSeenWrites.set(record.id, now);
    this.persist();
    for (const listener of this.onIssued) listener(record);
    return { token, session: publicSession(record) };
  }

  attemptAllowed(source: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const lock = this.lockState(source);
    return lock.locked ? { ok: false, retryAfterMs: lock.retryAfterMs } : { ok: true };
  }

  noteFailure(source: string): void {
    this.recordFailure(source);
  }

  clearFailures(source: string): void {
    this.failures.delete(source);
  }

  /** Email membership is live: losing any scope revokes the token and its streams; promotions never widen existing credentials. */
  revalidateEmailSessions(): void {
    if (this.closed) throw new Error("Session registry is closed.");
    // A team session's membership is the Admin's signed claim, checked at each pairing (cloud-team.ts), never the sign-in list.
    const eligible = this.sessions.filter(session => session.email !== undefined && session.membershipAuthority !== "team" && !(this.options.portalMembership && session.membershipAuthority === "portal"));
    if (!eligible.length) return;
    let resolveScopes = this.options.emailScopes;
    try {
      if (this.options.emailScopesSnapshot) resolveScopes = this.options.emailScopesSnapshot();
    } catch {
      resolveScopes = undefined; // Never fall back to stale membership after a failed snapshot.
    }
    const revoked = eligible.filter((session) => {
      try {
        const allowed = resolveScopes?.(session.email!);
        return !allowed || session.scopes.some((scope) => !allowed.includes(scope));
      } catch {
        return true; // missing or unreadable membership must fail closed
      }
    });
    if (!revoked.length) return;
    const ids = new Set(revoked.map((session) => session.id));
    this.sessions = this.sessions.filter((session) => !ids.has(session.id));
    for (const session of revoked) this.forget(session.id);
    try {
      this.persist();
    } catch {
      // Revocation holds in memory and streams close; the boot marker stops old bearers reviving after an unclean restart.
      console.error("Could not persist email session revocation.");
    }
  }

  authenticate(token: string | undefined): SessionRecord | null {
    if (!token) return null;
    this.revalidateEmailSessions();
    const hash = sha256(token);
    const now = this.now();
    const record = this.sessions.find((s) => sameDigest(s.tokenHash, hash));
    if (!record || record.expiresAt <= now || this.personal(record.scopes)) return null;
    const lastWrite = this.lastSeenWrites.get(record.id) ?? 0;
    if (now - lastWrite >= LAST_SEEN_WRITE_INTERVAL_MS) {
      record.lastSeenAt = now;
      this.lastSeenWrites.set(record.id, now);
      this.persist();
    }
    return record;
  }

  /** Call only after origin and scope checks pass; never revives an expired session. */
  renew(sessionId: string): boolean {
    this.revalidateEmailSessions();
    const record = this.sessions.find((s) => s.id === sessionId);
    const now = this.now();
    if (!record || record.expiresAt <= now) return false;
    if (record.expiresAt - now > SESSION_RENEW_WHEN_LEFT_MS) return false;
    const proposed = Math.min(now + SESSION_TTL_MS, record.createdAt + SESSION_MAX_AGE_MS);
    const next = record.membershipAuthority === "team" ? teamSessionExpiresAt(record.memberCheckedAt ?? record.createdAt, proposed) : proposed;
    if (next <= record.expiresAt) return false;
    record.expiresAt = next;
    record.lastSeenAt = now;
    this.lastSeenWrites.set(record.id, now);
    this.persist();
    return true;
  }

  isLive(sessionId: string): boolean {
    this.prune();
    return this.sessions.some((s) => s.id === sessionId && !this.personal(s.scopes));
  }

  list(): PublicSession[] {
    this.prune();
    return this.sessions.map(publicSession);
  }

  /** The live sessions a Team Cloud member's own codes opened: their phones. Never an Admin-signed pairing (an app). */
  memberPhones(): PublicSession[] {
    this.prune();
    return this.sessions.filter((s) => s.membershipAuthority === "team" && s.memberCheckedAt !== undefined).map(publicSession);
  }

  /** A person who left a Team Cloud: every session of theirs (app windows, phones) ends now, and no open code of theirs
   * can open another. With `keepRole` (the Admin vouched for them at that role), only those at another role end. Returns
   * how many sessions ended. */
  revokeMember(email: string, keepRole?: TeamRole): number {
    const address = email.trim().toLowerCase();
    this.pairings = this.pairings.filter((pairing) => pairing.member?.email.toLowerCase() !== address || pairing.member.role === keepRole);
    const ended = this.sessions.filter((session) => session.membershipAuthority === "team" && session.email?.toLowerCase() === address && (keepRole === undefined || session.teamRole !== keepRole));
    for (const session of ended) this.revoke(session.id);
    return ended.length;
  }

  revoke(id: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    this.forget(id);
    this.persist();
    return true;
  }

  issueStreamTicket(sessionId: string): { ticket: string; expiresAt: number } {
    this.prune();
    const mine = [...this.tickets].filter(([, t]) => t.sessionId === sessionId).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - (MAX_STREAM_TICKETS_PER_SESSION - 1)))) this.tickets.delete(hash);
    const ticket = `omb_tick_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + STREAM_TICKET_TTL_MS;
    this.tickets.set(sha256(ticket), { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  redeemStreamTicket(ticket: string): SessionRecord | null {
    this.prune();
    const hash = sha256(ticket);
    const entry = this.tickets.get(hash);
    if (!entry) return null;
    this.tickets.delete(hash);
    const now = this.now();
    const record = this.sessions.find((s) => s.id === entry.sessionId);
    return record && record.expiresAt > now && !this.personal(record.scopes) ? record : null;
  }
}
