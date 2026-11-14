// Every way a call start reaches the server, through the sign-in gate and then the Azure limit, as the server runs them.
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { teamRoleScopes, type TeamRole } from "./cloud-team.ts";
import { azureLiveCallRefusal, fishLiveCallRefusal, LIVE_AZURE_REFUSAL, LIVE_FISH_REFUSAL, liveScopeRefusal } from "./live-access.ts";
import { requiredScope, resolveRequestAuth, type RequestAuth, type ResolveOptions } from "./request-auth.ts";
import { SessionRegistry, type Scope, type SessionRecord } from "./sessions.ts";
import { moveInRefusal } from "./team-move-in.ts";

const LIVE = "/api/live/session";
const COOKIE = "omb_session_test";
const REMOTE = { host: "bots.example.com", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
const LOCAL = { host: "127.0.0.1:8799" };
const DESKTOP = { loopbackMutationToken: "desktop-secret", companionMutationToken: "relay-secret" };

let dir: string, sessions: SessionRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-live-access-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
});
afterEach(() => {
  sessions.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Place { resolve?: Partial<ResolveOptions>; othersOnLoopback?: boolean; provider?: "azure" | "openai" | "fish" }

/** "gets a call", or the words the person reads and who said them. */
function verdict(headers: Record<string, string>, place: Place = {}): string {
  const { auth, status, error } = resolveRequestAuth({ headers, method: "POST" } as unknown as IncomingMessage, {
    sessions, cookieName: COOKIE, streamPath: "/api/events", url: new URL(LIVE, "http://x"),
    scopeRefusal: (method, path) => liveScopeRefusal({ live: { provider: place.provider ?? "azure" } }, method, path),
    ...place.resolve,
  });
  if (!auth) return `sign-in gate ${status}: ${error}`;
  const refuse = place.provider === "fish" ? fishLiveCallRefusal : azureLiveCallRefusal;
  const refusal = refuse(auth, { othersOnLoopback: place.othersOnLoopback ?? false });
  return refusal ? `limit: ${refusal}` : "gets a call";
}

const bearer = (token: string) => ({ ...REMOTE, authorization: `Bearer ${token}` });
const device = (scopes: Scope[]) => bearer(sessions.issue({ label: "Device", scopes }).token);
function teamMember(role: TeamRole, phone = false) {
  const email = `${role}@acme.test`;
  const opened = sessions.openPairing({ scopes: teamRoleScopes(role), label: phone ? "Phone" : "App", member: { email, role }, ...(phone ? { memberCheckedAt: Date.now() } : {}) });
  const paired = sessions.exchange({ code: opened.code, label: "Device", source: "203.0.113.9" });
  if (!paired.ok) throw new Error(paired.error);
  return bearer(paired.token);
}
const portal = (scopes: Scope[]) => bearer(sessions.issuePortal({ email: "person@acme.test", grant: "g".repeat(43), scopes }).token);
const SERVICE = { resolve: { loopbackTrust: "service" as const } };
const CALL = "gets a call";
const AT_LIMIT = `limit: ${LIVE_AZURE_REFUSAL}`;
const AT_SIGN_IN = `sign-in gate 403: ${LIVE_AZURE_REFUSAL}`;

describe("an Azure Live call", () => {
  describe("in the desktop app", () => {
    const place = { resolve: DESKTOP };
    it("goes to the app's own window", () => {
      expect(verdict({ ...LOCAL, "x-openmausbot-desktop-owner": "desktop-secret" }, place)).toBe(CALL);
    });
    it("goes to the owner's phone, through the companion that authenticated it", () => {
      expect(verdict({ ...LOCAL, "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-1", "x-openmausbot-companion-auth": "relay-secret" }, place)).toBe(CALL);
    });
    it("is refused to a bot's shell and to a forged companion", () => {
      expect(verdict(LOCAL, place)).toMatch(/^sign-in gate 403: forbidden: this change must come from the desktop app/);
      expect(verdict({ ...LOCAL, "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-1", "x-openmausbot-companion-auth": "guessed" }, place)).toMatch(/^sign-in gate 403: forbidden: invalid companion/);
    });
    it("is refused to a remote device paired chat-only", () => {
      expect(verdict(device(["client"]), place)).toBe(AT_SIGN_IN);
    });
  });

  describe("on a server one person uses", () => {
    it("goes to the owner, locally or on a paired device", () => {
      expect(verdict(LOCAL)).toBe(CALL);
      expect(verdict(device(["admin", "client"]))).toBe(CALL);
    });
  });

  describe("on a self-hosted server others use too", () => {
    const place = { othersOnLoopback: true };
    it("goes to an admin's session", () => {
      expect(verdict(device(["admin", "client"]), place)).toBe(CALL);
    });
    it("is refused to a chat-only person, and to a local request, which may be any bot's shell", () => {
      expect(verdict(device(["client"]), place)).toBe(AT_SIGN_IN);
      expect(verdict(LOCAL, place)).toBe(AT_LIMIT);
    });
  });

  describe("on a person's own Cloud", () => {
    it("goes to the owner's session, and is refused to a bot's shell", () => {
      expect(verdict(device(["admin", "client"]), { ...SERVICE, othersOnLoopback: true })).toBe(CALL);
      expect(verdict(LOCAL, SERVICE)).toMatch(/^sign-in gate 403: forbidden: on this shared server/);
    });
  });

  describe("on a Team Cloud", () => {
    const place = { ...SERVICE, othersOnLoopback: true };
    it("goes to a Super admin and an Admin", () => {
      expect(verdict(teamMember("owner"), place)).toBe(CALL);
      expect(verdict(teamMember("admin"), place)).toBe(CALL);
    });
    it("is refused in plain words to a User, on the app or their phone", () => {
      expect(verdict(teamMember("member"), place)).toBe(AT_SIGN_IN);
      expect(verdict(teamMember("member", true), place)).toBe(AT_SIGN_IN);
    });
    it("is refused to a sign-in that only moves a bot in, whoever's it is", () => {
      const moving = bearer(sessions.issueMoveIn({ label: "Move in", email: "admin@acme.test", teamRole: "admin", bot: "bot1" }).token);
      expect(verdict(moving, { ...place, resolve: { ...SERVICE.resolve, restricted: moveInRefusal } })).toBe("sign-in gate 403: This sign-in only moves one bot in.");
      expect(verdict(moving, place)).toBe(AT_LIMIT);
    });
    it("is refused to a bot's shell", () => {
      expect(verdict(LOCAL, place)).toMatch(/^sign-in gate 403: forbidden: on this shared server/);
    });
  });

  describe("on a shared company workspace", () => {
    const place = { ...SERVICE, othersOnLoopback: true };
    beforeEach(() => {
      sessions.close();
      sessions = new SessionRegistry({ file: join(dir, "portal-sessions.json"), portalMembership: true });
    });
    it("goes to a workspace admin", () => {
      expect(verdict(portal(["admin", "client"]), place)).toBe(CALL);
    });
    it("is refused to anyone else, and to a local request even where an operator made loopback the owner", () => {
      expect(verdict(portal(["client"]), place)).toBe(AT_SIGN_IN);
      expect(verdict(LOCAL, place)).toMatch(/^sign-in gate 403: forbidden: on this shared server/);
      expect(verdict(LOCAL, { othersOnLoopback: true, resolve: { loopbackTrust: "owner" } })).toBe(AT_LIMIT);
    });
  });

  describe("from a published or shared page", () => {
    // A published page lives on another origin, and an inline one is sandboxed (`Origin: null`).
    const riding = (origin: string) => {
      const token = sessions.issue({ label: "Admin", scopes: ["admin", "client"] }).token;
      return { ...REMOTE, cookie: `${COOKIE}=${token}`, origin };
    };
    it("is refused, though the browser holds an admin's cookie", () => {
      expect(verdict(riding("https://abc.example.page"))).toBe("sign-in gate 403: forbidden: cross-origin request");
      expect(verdict(riding("null"))).toBe("sign-in gate 403: forbidden: cross-origin request");
    });
    it("is refused inside the desktop app's window too, where the app adds its owner header to every request", () => {
      const sandboxed = { ...LOCAL, "x-openmausbot-desktop-owner": "desktop-secret", origin: "null", "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" };
      expect(verdict(sandboxed, { resolve: DESKTOP })).toBe("sign-in gate 403: forbidden: cross-origin request");
      const sameHostPage = { ...LOCAL, "x-openmausbot-desktop-owner": "desktop-secret", origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site", "sec-fetch-dest": "empty" };
      expect(verdict(sameHostPage, { resolve: DESKTOP })).toMatch(/^sign-in gate 401: unauthorized: this browser is not signed in/);
    });
    it("is refused with no credential at all", () => {
      expect(verdict({ ...REMOTE, origin: "https://abc.example.page" })).toMatch(/^sign-in gate 403: forbidden: this request came through a proxy/);
    });
  });

  it("is refused to a caller the rule does not recognise", () => {
    const unknown = { kind: "something-new", scopes: ["admin", "client"] } as unknown as RequestAuth;
    expect(azureLiveCallRefusal(unknown, { othersOnLoopback: false })).toBe(LIVE_AZURE_REFUSAL);
  });

  it("is refused to a session marked a team User even if its scopes say admin", () => {
    const session = { id: "s", teamRole: "member", scopes: ["admin", "client"] } as unknown as SessionRecord;
    const auth: RequestAuth = { kind: "session", session, via: "bearer", scopes: session.scopes };
    expect(azureLiveCallRefusal(auth, { othersOnLoopback: false })).toBe(LIVE_AZURE_REFUSAL);
  });
});

describe("the words for a session without the admin scope", () => {
  it("name Azure only for a call start, and only with Azure chosen", () => {
    expect(verdict(device(["client"]), { provider: "openai" })).toBe("sign-in gate 403: forbidden: this session lacks the admin scope");
    expect(liveScopeRefusal({ live: { provider: "azure" } }, "post", LIVE)).toBe(LIVE_AZURE_REFUSAL);
    expect(liveScopeRefusal({ live: { provider: "azure" } }, "GET", "/api/live/call")).toBeNull();
    expect(liveScopeRefusal({ live: { provider: "azure" } }, "PATCH", "/api/live/settings")).toBeNull();
    expect(liveScopeRefusal({}, "POST", LIVE)).toBeNull();
    expect(liveScopeRefusal({ live: { provider: "fish" } }, "POST", LIVE)).toBe(LIVE_FISH_REFUSAL);
    expect(liveScopeRefusal({ live: { provider: "fish" } }, "POST", "/api/live/relay")).toBeNull();
  });
  it("change no one's scope: every Live route stays closed to a client session", () => {
    for (const [method, path] of [["POST", LIVE], ["POST", "/api/live/call/end"], ["GET", "/api/live/call"], ["PATCH", "/api/live/settings"], ["POST", "/api/live/device-revoked"], ["POST", "/api/live/relay"]] as const) {
      expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
    }
  });
});

describe("a Fish Audio Live call", () => {
  const FISH = { provider: "fish" as const };
  const TEAM = { ...FISH, ...SERVICE, othersOnLoopback: true };

  it("goes to the desktop app's own window, the owner, and a team admin, as on Azure", () => {
    expect(verdict({ ...LOCAL, "x-openmausbot-desktop-owner": "desktop-secret" }, { ...FISH, resolve: DESKTOP })).toBe(CALL);
    expect(verdict(LOCAL, FISH)).toBe(CALL);
    expect(verdict(device(["admin", "client"]), FISH)).toBe(CALL);
    expect(verdict(teamMember("admin"), TEAM)).toBe(CALL);
  });

  it("is refused in its own words to a chat-only session, a team User and a local request others share", () => {
    expect(verdict(device(["client"]), FISH)).toBe(`sign-in gate 403: ${LIVE_FISH_REFUSAL}`);
    expect(verdict(teamMember("member"), TEAM)).toBe(`sign-in gate 403: ${LIVE_FISH_REFUSAL}`);
    expect(verdict(LOCAL, { ...FISH, othersOnLoopback: true })).toBe(`limit: ${LIVE_FISH_REFUSAL}`);
    const unknown = { kind: "something-new", scopes: ["admin", "client"] } as unknown as RequestAuth;
    expect(fishLiveCallRefusal(unknown, { othersOnLoopback: false })).toBe(LIVE_FISH_REFUSAL);
  });
});
