// Accounts for the public NATION server: one person, one email, one workspace.
//
// Signing in is an emailed one-time link (server/account-gateway.ts). The
// link carries a random token; only its sha256 is stored, it lives a few
// minutes and works once. Redeeming it opens an account session, a separate
// credential from the founder desk's sessions (server/sessions.ts): an
// account session can only ever reach its own workspace, which runs as its
// own server over its own data directory (server/workspace-host.ts).
//
// Everything lives in one SQLite file next to the credit ledger, so a
// restart keeps who has an account, which workspace is theirs, and who is
// signed in.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SESSION_MAX_AGE_MS, SESSION_RENEW_WHEN_LEFT_MS, SESSION_TTL_MS } from "./sessions.ts";

export const ACCOUNT_COOKIE = "nation_account";
export const MAGIC_LINK_PREFIX = "nml_";
export const ACCOUNT_TOKEN_PREFIX = "nas_";

/** Minutes a sign-in link stays usable; NATION_MAGIC_LINK_TTL_MINUTES, 5 to 60. */
export function magicLinkTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.NATION_MAGIC_LINK_TTL_MINUTES);
  return (Number.isInteger(minutes) && minutes >= 5 && minutes <= 60 ? minutes : 15) * 60_000;
}

/** How often one address and one network may ask for a link. */
export const MAGIC_LINK_LIMITS = {
  perEmail: { count: 3, windowMs: 15 * 60_000 },
  perSource: { count: 20, windowMs: 60 * 60_000 },
} as const;

/** Links this server sends per hour in all, so a burst cannot use up the mail
 * provider's quota; NATION_MAGIC_LINKS_PER_HOUR, default 500. */
export function magicLinksPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const count = Number(env.NATION_MAGIC_LINKS_PER_HOUR);
  return Number.isInteger(count) && count >= 1 && count <= 100_000 ? count : 500;
}

/** Links one network may ask for per hour; NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR,
 * default MAGIC_LINK_LIMITS.perSource. Behind a web front end whose visitors
 * cannot be told apart (no NATION_CLIENT_IP_HEADER), every visitor is one network. */
export function magicLinksPerNetworkPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const count = Number(env.NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR);
  return Number.isInteger(count) && count >= 1 && count <= 100_000 ? count : MAGIC_LINK_LIMITS.perSource.count;
}

export interface AccountUser {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AccountWorkspace {
  id: string;
  userId: string;
  createdAt: number;
}

export interface AccountSession {
  id: string;
  userId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** Which workspace, and the one account it belongs to. */
export interface WorkspaceRef {
  id: string;
  userId: string;
  email: string;
}

export interface AccountIdentity {
  session: AccountSession;
  user: AccountUser;
  workspace: AccountWorkspace;
}

export type MagicLinkRequest =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 429; error: string; retryAfterMs: number };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Lower case, trimmed, one @ and a dot after it, at most 254 characters; "" when not an address. */
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 320) return "";
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

/** Workspace ids name directories, so they are plain and fixed-length. */
export function isWorkspaceId(value: string): boolean {
  return /^ws_[A-Za-z0-9_-]{22}$/.test(value);
}

function userRow(row: Record<string, unknown> | undefined): AccountUser | null {
  if (!row) return null;
  return { id: String(row.id), email: String(row.email), createdAt: Number(row.created_at), lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at) };
}

function workspaceRow(row: Record<string, unknown> | undefined): AccountWorkspace | null {
  if (!row) return null;
  return { id: String(row.id), userId: String(row.user_id), createdAt: Number(row.created_at) };
}

function sessionRow(row: Record<string, unknown> | undefined): AccountSession | null {
  if (!row) return null;
  return {
    id: String(row.id), userId: String(row.user_id), label: String(row.label),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), expiresAt: Number(row.expires_at),
  };
}

export class AccountStore {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private lastPrune = 0;

  constructor(file: string, options: { now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_login_at INTEGER);
      CREATE TABLE IF NOT EXISTS account_workspaces(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES account_users(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_magic_links(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, source_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS account_magic_links_email ON account_magic_links(email, created_at);
      CREATE INDEX IF NOT EXISTS account_magic_links_source ON account_magic_links(source_hash, created_at);
      CREATE TABLE IF NOT EXISTS account_sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES account_users(id), label TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
    `);
  }

  close(): void { this.db.close(); }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Spent links and lapsed sessions go after a day; at most once a minute. */
  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    this.db.prepare("DELETE FROM account_magic_links WHERE created_at<?").run(now - 24 * 60 * 60_000);
    this.db.prepare("DELETE FROM account_sessions WHERE expires_at<=?").run(now);
  }

  // ── sign-in links ─────────────────────────────────────────────────────

  /** A new one-time link for an address, unless that address or network has asked too often. */
  requestMagicLink(email: string, source: string): MagicLinkRequest {
    const address = normalizeEmail(email);
    if (!address) throw new Error("requestMagicLink needs a normalized email");
    this.prune();
    const now = this.now();
    const sourceHash = sha256(`source:${source}`);
    return this.transaction((): MagicLinkRequest => {
      const limited = (column: "email" | "source_hash", value: string, limit: { count: number; windowMs: number }) => {
        const rows = this.db.prepare(`SELECT created_at FROM account_magic_links WHERE ${column}=? AND created_at>? ORDER BY created_at ASC`).all(value, now - limit.windowMs);
        if (rows.length < limit.count) return 0;
        return Math.max(1_000, Number(rows[rows.length - limit.count]!.created_at) + limit.windowMs - now);
      };
      const waitEmail = limited("email", address, MAGIC_LINK_LIMITS.perEmail);
      const waitSource = limited("source_hash", sourceHash, { ...MAGIC_LINK_LIMITS.perSource, count: magicLinksPerNetworkPerHour(this.env) });
      const sentLastHour = Number(this.db.prepare("SELECT COUNT(*) AS n FROM account_magic_links WHERE created_at>?").get(now - 60 * 60_000)?.n ?? 0);
      const waitEveryone = sentLastHour >= magicLinksPerHour(this.env) ? 5 * 60_000 : 0;
      if (waitEmail || waitSource || waitEveryone) {
        const retryAfterMs = Math.max(waitEmail, waitSource, waitEveryone);
        return { ok: false, status: 429, retryAfterMs, error: `Too many sign-in emails. Try again in ${Math.ceil(retryAfterMs / 60_000)} minute${retryAfterMs > 60_000 ? "s" : ""}.` };
      }
      const token = `${MAGIC_LINK_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = now + magicLinkTtlMs(this.env);
      this.db.prepare("INSERT INTO account_magic_links VALUES(?,?,?,?,?,NULL)").run(sha256(token), address, sourceHash, now, expiresAt);
      return { ok: true, token, expiresAt };
    });
  }

  /** The address a still-usable link is for, without using it up (the confirm screen shows it). */
  peekMagicLink(token: unknown): string | null {
    if (typeof token !== "string" || !token.startsWith(MAGIC_LINK_PREFIX) || token.length > 128) return null;
    const row = this.db.prepare("SELECT email FROM account_magic_links WHERE token_hash=? AND used_at IS NULL AND expires_at>?").get(sha256(token), this.now());
    return row ? String(row.email) : null;
  }

  /** Use a link up. Returns its address once; every later call, and any
   * expired or unknown token, returns null. Redeeming one link retires the
   * other unused links for the same address. */
  consumeMagicLink(token: unknown): string | null {
    if (typeof token !== "string" || !token.startsWith(MAGIC_LINK_PREFIX) || token.length > 128) return null;
    const now = this.now();
    const hash = sha256(token);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT email FROM account_magic_links WHERE token_hash=? AND used_at IS NULL AND expires_at>?").get(hash, now);
      if (!row) return null;
      const email = String(row.email);
      this.db.prepare("UPDATE account_magic_links SET used_at=? WHERE email=? AND used_at IS NULL").run(now, email);
      return email;
    });
  }

  // ── people and their workspaces ───────────────────────────────────────

  userByEmail(email: string): AccountUser | null {
    return userRow(this.db.prepare("SELECT * FROM account_users WHERE email=?").get(normalizeEmail(email)));
  }

  user(id: string): AccountUser | null {
    return userRow(this.db.prepare("SELECT * FROM account_users WHERE id=?").get(id));
  }

  /** The account for an address, created on first sign-in. */
  ensureUser(email: string): AccountUser {
    const address = normalizeEmail(email);
    if (!address) throw new Error("ensureUser needs an email address");
    const now = this.now();
    this.db.prepare("INSERT INTO account_users VALUES(?,?,?,NULL) ON CONFLICT(email) DO NOTHING").run(`usr_${randomUUID()}`, address, now);
    return this.userByEmail(address)!;
  }

  noteLogin(userId: string): void {
    this.db.prepare("UPDATE account_users SET last_login_at=? WHERE id=?").run(this.now(), userId);
  }

  workspaceOf(userId: string): AccountWorkspace | null {
    return workspaceRow(this.db.prepare("SELECT * FROM account_workspaces WHERE user_id=?").get(userId));
  }

  workspace(id: string): AccountWorkspace | null {
    return workspaceRow(this.db.prepare("SELECT * FROM account_workspaces WHERE id=?").get(id));
  }

  workspaceCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM account_workspaces").get()?.n ?? 0);
  }

  /** The person's workspace; the first sign-in creates it, unless `limit`
   * workspaces already exist (then null, and nothing is created). */
  ensureWorkspace(userId: string, limit = Infinity): { workspace: AccountWorkspace; created: boolean } | null {
    return this.transaction(() => {
      const existing = this.workspaceOf(userId);
      if (existing) return { workspace: existing, created: false };
      if (this.workspaceCount() >= limit) return null;
      const workspace = { id: `ws_${randomBytes(16).toString("base64url")}`, userId, createdAt: this.now() };
      this.db.prepare("INSERT INTO account_workspaces VALUES(?,?,?)").run(workspace.id, workspace.userId, workspace.createdAt);
      return { workspace, created: true };
    });
  }

  listWorkspaces(): Array<AccountWorkspace & { email: string }> {
    return this.db.prepare("SELECT w.*, u.email FROM account_workspaces w JOIN account_users u ON u.id=w.user_id ORDER BY w.created_at").all()
      .map((row) => ({ ...workspaceRow(row)!, email: String(row.email) }));
  }

  // ── account sessions ──────────────────────────────────────────────────

  /** Same term as a founder-desk session: 30 days, renewed on use, never past 180. */
  openSession(userId: string, label: string): { token: string; session: AccountSession } {
    this.prune();
    const now = this.now();
    const token = `${ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const session: AccountSession = {
      id: randomUUID(), userId, label: (label.trim() || "Browser").slice(0, 80),
      createdAt: now, lastSeenAt: now, expiresAt: now + Math.min(SESSION_TTL_MS, SESSION_MAX_AGE_MS),
    };
    this.transaction(() => {
      this.db.prepare("UPDATE account_users SET last_login_at=? WHERE id=?").run(now, userId);
      this.db.prepare("INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?)")
        .run(session.id, sha256(token), userId, session.label, session.createdAt, session.lastSeenAt, session.expiresAt);
    });
    return { token, session };
  }

  /** Who a presented account token belongs to, renewing a session that is
   * past half its term. Null for anything unknown, expired or malformed. */
  authenticate(token: string | undefined): AccountIdentity | null {
    if (!token || !token.startsWith(ACCOUNT_TOKEN_PREFIX) || token.length > 128) return null;
    const now = this.now();
    const hash = sha256(token);
    const found = this.db.prepare("SELECT * FROM account_sessions WHERE token_hash=?").get(hash);
    if (!found) return null;
    const session = sessionRow(found)!;
    if (session.expiresAt <= now) return null;
    const user = this.user(session.userId);
    const workspace = user ? this.workspaceOf(user.id) : null;
    if (!user || !workspace) return null;
    if (session.expiresAt - now <= SESSION_RENEW_WHEN_LEFT_MS) {
      const next = Math.min(now + SESSION_TTL_MS, session.createdAt + SESSION_MAX_AGE_MS);
      if (next > session.expiresAt) session.expiresAt = next;
    }
    if (now - session.lastSeenAt >= 60_000 || session.expiresAt !== Number(found.expires_at)) {
      session.lastSeenAt = now;
      this.db.prepare("UPDATE account_sessions SET last_seen_at=?, expires_at=? WHERE id=?").run(now, session.expiresAt, session.id);
    }
    return { session, user, workspace };
  }

  revokeSession(id: string): boolean {
    return this.db.prepare("DELETE FROM account_sessions WHERE id=?").run(id).changes > 0;
  }
}
