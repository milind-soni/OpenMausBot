import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore, isWorkspaceId, MAGIC_LINK_LIMITS, normalizeEmail } from "./accounts.ts";
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS } from "./sessions.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(options: { env?: NodeJS.ProcessEnv; file?: string } = {}) {
  let now = Date.UTC(2026, 8, 26, 12);
  const file = options.file ?? ":memory:";
  const accounts = new AccountStore(file, { now: () => now, env: options.env ?? {} });
  return { accounts, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("addresses", () => {
  it("normalizes case and space and refuses what is not an address", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    for (const bad of ["", "alice", "alice@", "@example.com", "alice@example", "a b@example.com", 42, null, "x".repeat(250) + "@example.com"]) {
      expect(normalizeEmail(bad)).toBe("");
    }
  });
});

describe("sign-in links", () => {
  it("works once, for its own address, and retires the other links for that address", () => {
    const { accounts } = store();
    const first = accounts.requestMagicLink("alice@example.test", "1.1.1.1");
    const second = accounts.requestMagicLink("alice@example.test", "1.1.1.1");
    const other = accounts.requestMagicLink("bob@example.test", "1.1.1.1");
    if (!first.ok || !second.ok || !other.ok) throw new Error("expected links");
    expect(first.token).toMatch(/^nml_[A-Za-z0-9_-]{43}$/);
    expect(accounts.peekMagicLink(first.token)).toBe("alice@example.test");
    expect(accounts.peekMagicLink(first.token)).toBe("alice@example.test"); // peeking spends nothing
    expect(accounts.consumeMagicLink(first.token)).toBe("alice@example.test");
    expect(accounts.consumeMagicLink(first.token)).toBeNull();
    expect(accounts.peekMagicLink(first.token)).toBeNull();
    expect(accounts.consumeMagicLink(second.token)).toBeNull();
    expect(accounts.consumeMagicLink(other.token)).toBe("bob@example.test");
  });

  it("expires after its lifetime (15 minutes unless configured)", () => {
    const { accounts, advance } = store();
    const link = accounts.requestMagicLink("alice@example.test", "1.1.1.1");
    if (!link.ok) throw new Error("expected a link");
    advance(15 * 60_000);
    expect(accounts.consumeMagicLink(link.token)).toBeNull();

    const short = store({ env: { NATION_MAGIC_LINK_TTL_MINUTES: "5" } });
    const soon = short.accounts.requestMagicLink("alice@example.test", "1.1.1.1");
    if (!soon.ok) throw new Error("expected a link");
    expect(soon.expiresAt - short.now()).toBe(5 * 60_000);
  });

  it("stores only a digest of the token", () => {
    const { accounts } = store();
    const link = accounts.requestMagicLink("alice@example.test", "1.1.1.1");
    if (!link.ok) throw new Error("expected a link");
    const rows = JSON.stringify(accounts.db.prepare("SELECT * FROM account_magic_links").all());
    expect(rows).not.toContain(link.token);
    expect(rows).not.toContain(link.token.slice(4));
    expect(rows).not.toContain("1.1.1.1");
  });

  it("refuses garbage without touching the database", () => {
    const { accounts } = store();
    for (const bad of [undefined, 1, "", "nml_", "nas_" + "a".repeat(43), "nml_" + "a".repeat(200)]) {
      expect(accounts.consumeMagicLink(bad)).toBeNull();
      expect(accounts.peekMagicLink(bad)).toBeNull();
    }
  });

  it("limits links per address, per network and in all", () => {
    const { accounts, advance } = store({ env: { NATION_MAGIC_LINKS_PER_HOUR: "30" } });
    for (let i = 0; i < MAGIC_LINK_LIMITS.perEmail.count; i++) expect(accounts.requestMagicLink("alice@example.test", `10.0.0.${i}`).ok).toBe(true);
    const limited = accounts.requestMagicLink("alice@example.test", "10.0.0.9");
    expect(limited).toMatchObject({ ok: false, status: 429 });
    if (limited.ok) throw new Error("expected a limit");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(MAGIC_LINK_LIMITS.perEmail.windowMs);
    advance(MAGIC_LINK_LIMITS.perEmail.windowMs);
    expect(accounts.requestMagicLink("alice@example.test", "10.0.0.9").ok).toBe(true);

    for (let i = 0; i < MAGIC_LINK_LIMITS.perSource.count; i++) expect(accounts.requestMagicLink(`user${i}@example.test`, "192.0.2.1").ok).toBe(true);
    expect(accounts.requestMagicLink("late@example.test", "192.0.2.1").ok).toBe(false);
    expect(accounts.requestMagicLink("late@example.test", "192.0.2.2").ok).toBe(true);

    // 30 an hour for everyone together: 4 + 20 + 1 so far.
    for (let i = 0; i < 5; i++) expect(accounts.requestMagicLink(`crowd${i}@example.test`, `198.51.100.${i}`).ok).toBe(true);
    expect(accounts.requestMagicLink("crowd9@example.test", "198.51.100.9").ok).toBe(false);
  });

  it("lets the operator set the per-network limit for a front end whose visitors look alike", () => {
    const { accounts } = store({ env: { NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR: "25" } });
    for (let i = 0; i < 25; i++) expect(accounts.requestMagicLink(`user${i}@example.test`, "76.76.21.9").ok).toBe(true);
    expect(accounts.requestMagicLink("late@example.test", "76.76.21.9").ok).toBe(false);
    expect(store({ env: { NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR: "0" } }).accounts.requestMagicLink("a@example.test", "x").ok).toBe(true);
  });
});

describe("accounts and workspaces", () => {
  it("creates one user per address and one workspace per user", () => {
    const { accounts } = store();
    const alice = accounts.ensureUser("Alice@Example.test");
    expect(accounts.ensureUser("alice@example.test").id).toBe(alice.id);
    expect(alice.id).toMatch(/^usr_/);
    const first = accounts.ensureWorkspace(alice.id);
    const again = accounts.ensureWorkspace(alice.id);
    expect(first?.created).toBe(true);
    expect(again).toEqual({ workspace: first!.workspace, created: false });
    expect(isWorkspaceId(first!.workspace.id)).toBe(true);
    const bob = accounts.ensureUser("bob@example.test");
    expect(accounts.ensureWorkspace(bob.id)!.workspace.id).not.toBe(first!.workspace.id);
    expect(accounts.listWorkspaces().map((workspace) => workspace.email)).toEqual(["alice@example.test", "bob@example.test"]);
  });

  it("creates no workspace past the limit, but still returns an existing one", () => {
    const { accounts } = store();
    const alice = accounts.ensureUser("alice@example.test");
    accounts.ensureWorkspace(alice.id, 1);
    const bob = accounts.ensureUser("bob@example.test");
    expect(accounts.ensureWorkspace(bob.id, 1)).toBeNull();
    expect(accounts.workspaceOf(bob.id)).toBeNull();
    expect(accounts.ensureWorkspace(alice.id, 1)?.created).toBe(false);
  });

  it("never accepts a path-like workspace id", () => {
    for (const bad of ["ws_../../etc/passwd00000", "ws_short", "../ws_aaaaaaaaaaaaaaaaaaaaaa", "ws_aaaaaaaaaaaaaaaaaaaaa/"]) expect(isWorkspaceId(bad)).toBe(false);
  });
});

describe("account sessions", () => {
  it("authenticates the token it issued, slides its term and stops at the absolute cap", () => {
    const { accounts, advance, now } = store();
    const user = accounts.ensureUser("alice@example.test");
    const { workspace } = accounts.ensureWorkspace(user.id)!;
    const { token, session } = accounts.openSession(user.id, "Safari on iPhone");
    expect(token).toMatch(/^nas_[A-Za-z0-9_-]{43}$/);
    expect(accounts.authenticate(token)).toMatchObject({ user: { email: "alice@example.test" }, workspace: { id: workspace.id }, session: { id: session.id } });
    expect(accounts.user(user.id)?.lastLoginAt).toBe(now());
    // Past half its term, a use renews it.
    advance(SESSION_TTL_MS * 0.75);
    const renewed = accounts.authenticate(token)!;
    expect(renewed.session.expiresAt).toBe(now() + SESSION_TTL_MS);
    // Never beyond the cap from sign-in.
    const started = session.createdAt;
    for (let i = 0; i < 20; i++) {
      advance(SESSION_TTL_MS * 0.75);
      if (!accounts.authenticate(token)) break;
    }
    expect(now() - started).toBeGreaterThanOrEqual(SESSION_MAX_AGE_MS);
    expect(accounts.authenticate(token)).toBeNull();
  });

  it("forgets a revoked or unknown token, and never stores the token", () => {
    const { accounts } = store();
    const user = accounts.ensureUser("alice@example.test");
    accounts.ensureWorkspace(user.id);
    const { token, session } = accounts.openSession(user.id, "");
    expect(JSON.stringify(accounts.db.prepare("SELECT * FROM account_sessions").all())).not.toContain(token);
    expect(accounts.authenticate("nas_" + "A".repeat(43))).toBeNull();
    expect(accounts.authenticate("omb_sess_" + "A".repeat(43))).toBeNull();
    expect(accounts.revokeSession(session.id)).toBe(true);
    expect(accounts.authenticate(token)).toBeNull();
  });

  it("is refused while the account has no workspace", () => {
    const { accounts } = store();
    const user = accounts.ensureUser("alice@example.test");
    const { token } = accounts.openSession(user.id, "");
    expect(accounts.authenticate(token)).toBeNull();
  });

  it("survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "nation-accounts-"));
    dirs.push(dir);
    const file = join(dir, "nation-accounts.db");
    const first = new AccountStore(file);
    const user = first.ensureUser("alice@example.test");
    const { workspace } = first.ensureWorkspace(user.id)!;
    const { token } = first.openSession(user.id, "Browser");
    first.close();
    const second = new AccountStore(file);
    expect(second.authenticate(token)?.workspace.id).toBe(workspace.id);
    second.close();
  });
});
