// Phase 5: identity-header sign-on. The property that matters most here is
// that it is INERT — a server without the entitlement and the config must
// behave exactly as it did before, however many identity headers a request
// waves around. These drive the pieces directly (the wiring in index.ts reads
// cfg.sso and entitled("sso") and hands resolveRequestAuth the two callbacks).
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { roleScopes, UserRegistry } from "./users.ts";

let dir: string;
let sessions: SessionRegistry;
let users: UserRegistry;
const cookieName = "omb_session_8799_env";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-sso-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  users = new UserRegistry({ file: join(dir, "users.json") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A request arriving through a proxy, as an SSO deployment always does. */
function proxied(headers: Record<string, string> = {}): IncomingMessage {
  // SAFETY: the resolver reads only headers and method.
  return { headers: { host: "maus.example.com", "x-forwarded-for": "203.0.113.9", ...headers }, method: "GET" } as unknown as IncomingMessage;
}

/** The two callbacks index.ts supplies when SSO is on. */
function ssoOption(headerName = "x-auth-request-user") {
  return {
    resolve: (req: IncomingMessage) => {
      const raw = req.headers[headerName];
      const email = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (!email) return null;
      // Mirrors resolveSsoUserId in index.ts: a disabled person still
      // resolves so the chokepoint can say why they are refused.
      const existing = users.findByEmail(email);
      if (existing) return existing.id;
      return users.create({ name: email, email, role: users.isEmpty() ? "admin" : "member" }, null).id;
    },
    session: (userId: string) => sessions.upsertSsoSession(userId, [...roleScopes(users.find(userId)!.role)]),
  };
}

const ask = (req: IncomingMessage, path: string, sso?: ReturnType<typeof ssoOption>) =>
  resolveRequestAuth(req, { sessions, users, cookieName, streamPath: "/api/events", url: new URL(path, "http://x"), ...(sso ? { sso } : {}) });

const ADMIN_ROUTE = "/api/auth/sessions";
const CLIENT_ROUTE = "/api/bots";

describe("with SSO off (every deployment by default)", () => {
  it("ignores identity headers completely", () => {
    // No `sso` option is what index.ts produces when the entitlement or the
    // config says no. The header must buy exactly nothing.
    const denied = ask(proxied({ "x-auth-request-user": "ada@example.test" }), CLIENT_ROUTE);
    expect(denied.auth).toBeNull();
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/came through a proxy/);
    // And it certainly must not have provisioned anybody.
    expect(users.list()).toEqual([]);
  });
});

describe("with SSO on", () => {
  it("signs in the header's person, provisioning the first one as admin", () => {
    const auth = ask(proxied({ "x-auth-request-user": "ada@example.test" }), ADMIN_ROUTE, ssoOption()).auth;
    expect(auth?.kind).toBe("session");
    expect(auth?.user?.name).toBe("ada@example.test");
    expect(auth?.user?.role).toBe("admin"); // first account on a fresh server
    expect(auth?.scopes).toEqual(["admin", "client"]);
  });

  it("gives everyone after the first the member role, enforced at the chokepoint", () => {
    ask(proxied({ "x-auth-request-user": "ada@example.test" }), CLIENT_ROUTE, ssoOption()); // the admin
    const bob = proxied({ "x-auth-request-user": "bob@example.test" });
    expect(ask(bob, CLIENT_ROUTE, ssoOption()).auth?.scopes).toEqual(["client"]);
    const refused = ask(bob, ADMIN_ROUTE, ssoOption());
    expect(refused.auth).toBeNull();
    expect(refused.error).toMatch(/lacks the admin scope/);
  });

  it("reuses one session per person instead of piling up a new one each request", () => {
    const req = proxied({ "x-auth-request-user": "ada@example.test" });
    const first = ask(req, CLIENT_ROUTE, ssoOption()).auth;
    const second = ask(req, CLIENT_ROUTE, ssoOption()).auth;
    expect(first?.kind).toBe("session");
    if (first?.kind === "session" && second?.kind === "session") {
      expect(second.session.id).toBe(first.session.id);
    }
    expect(sessions.list()).toHaveLength(1);
    // It is a real, revocable session — so disable and revoke work on it.
    expect(sessions.list()[0].userId).toBe(first?.user?.id);
  });

  it("refuses a disabled account, and follows a role change without a new header", () => {
    const ada = ask(proxied({ "x-auth-request-user": "ada@example.test" }), CLIENT_ROUTE, ssoOption()).auth!;
    users.create({ name: "Second admin", role: "admin" }, null); // so guard A allows the change
    const bob = proxied({ "x-auth-request-user": "bob@example.test" });
    const bobId = ask(bob, CLIENT_ROUTE, ssoOption()).auth!.user!.id;

    users.update(bobId, { role: "admin" });
    expect(ask(bob, ADMIN_ROUTE, ssoOption()).auth?.scopes).toEqual(["admin", "client"]);
    users.update(bobId, { role: "member" });
    expect(ask(bob, ADMIN_ROUTE, ssoOption()).auth).toBeNull();

    users.update(bobId, { status: "disabled" });
    const denied = ask(bob, CLIENT_ROUTE, ssoOption());
    expect(denied.status).toBe(403);
    expect(denied.error).toBe("forbidden: this account is disabled");
    expect(ada.user?.name).toBe("ada@example.test");
  });

  it("lets a real bearer token win over the header", () => {
    const ada = users.create({ name: "Ada", email: "ada@example.test", role: "admin" }, null);
    users.create({ name: "Bob", email: "bob@example.test", role: "member" }, null);
    const { code } = sessions.openPairing({ userId: ada.id });
    const paired = sessions.exchange({ code, label: "Ada laptop", source: "s" });
    if (!paired.ok) throw new Error(paired.error);

    // The header claims Bob; the token says Ada. The token is tried first.
    const auth = ask(
      proxied({ authorization: `Bearer ${paired.token}`, "x-auth-request-user": "bob@example.test" }),
      ADMIN_ROUTE,
      ssoOption(),
    ).auth;
    expect(auth?.user?.id).toBe(ada.id);
  });

  it("does nothing without the header, and honours a custom header name", () => {
    expect(ask(proxied(), CLIENT_ROUTE, ssoOption()).auth).toBeNull();
    expect(ask(proxied({ "x-auth-request-user": "   " }), CLIENT_ROUTE, ssoOption()).auth).toBeNull();
    expect(users.list()).toEqual([]);

    const custom = ssoOption("x-company-user");
    expect(ask(proxied({ "x-company-user": "ada@example.test" }), CLIENT_ROUTE, custom).auth?.user?.name).toBe("ada@example.test");
    // The default name is not consulted when a custom one is configured.
    expect(ask(proxied({ "x-auth-request-user": "sneaky@example.test" }), CLIENT_ROUTE, custom).auth).toBeNull();
  });

  it("never grants loopback ownership through the header", () => {
    // A loopback request that also carries forwarded headers is proxied, so it
    // is remote by construction — the header cannot be used to become the owner.
    const auth = ask(proxied({ host: "127.0.0.1:8799", "x-auth-request-user": "ada@example.test" }), ADMIN_ROUTE, ssoOption()).auth;
    expect(auth?.kind).toBe("session");
    expect(auth?.user).not.toBeNull();
  });
});
