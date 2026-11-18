import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPersonNames } from "../host/person-names.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { callRoute } from "./call-route.ts";
import { createMeRoutes, type MeRouteDeps } from "./me.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const session = (id: string, email?: string): SessionRecord => ({ id, tokenHash: "0".repeat(64), label: "Chrome on Mac", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: 1, ...(email ? { email } : {}) });
const signedIn = (record: SessionRecord): RequestAuth => ({ kind: "session", session: record, via: "bearer", scopes: record.scopes });
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

function selfHosted(names: MeRouteDeps["names"]) {
  const changed = vi.fn();
  const routes = createMeRoutes({
    team: null, session: (auth) => (auth.kind === "session" ? auth.session : null), changed, names,
    welcome: { read: () => { throw new Error("no welcome off a team"); }, save: () => { throw new Error("no welcome off a team"); } },
    profile: () => { throw new Error("no member profile off a team"); }, save: () => { throw new Error("no member profile off a team"); },
    seed: () => { throw new Error("no member profile off a team"); }, seeded: () => [],
  });
  return { routes, changed };
}

describe("/api/me on a self-hosted server", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-me-route-")); dirs.push(dir);
    const store = createPersonNames(dir);
    return selfHosted({ store, shownAs: (record) => store.of(record) ?? record.email ?? record.label }).routes;
  };

  it("lets each signed-in person read and set the name they go by, and clear it again", async () => {
    const routes = setup();
    const grace = signedIn(session("s1", "grace@example.test"));
    expect(await callRoute(routes, { method: "GET", path: "/api/me", auth: grace })).toEqual({ status: 200, body: { displayName: "", shownAs: "grace@example.test" } });
    expect(await callRoute(routes, { method: "PUT", path: "/api/me", auth: grace, body: { displayName: "  Grace Hopper " } })).toEqual({ status: 200, body: { displayName: "Grace Hopper", shownAs: "Grace Hopper" } });
    const device = signedIn(session("s2"));
    expect((await callRoute(routes, { method: "GET", path: "/api/me", auth: device })).body).toEqual({ displayName: "", shownAs: "Chrome on Mac" });
    expect((await callRoute(routes, { method: "GET", path: "/api/me", auth: signedIn(session("s3", "grace@example.test")) })).body.displayName).toBe("Grace Hopper");
    expect(await callRoute(routes, { method: "PUT", path: "/api/me", auth: grace, body: { displayName: "" } })).toEqual({ status: 200, body: { displayName: "", shownAs: "grace@example.test" } });
  });

  it("refuses a name that is too long, holds a control character, or is not text", async () => {
    const routes = setup();
    const grace = signedIn(session("s1", "grace@example.test"));
    for (const displayName of ["x".repeat(61), "Grace\u0007", "Grace\nHopper"]) {
      expect(await callRoute(routes, { method: "PUT", path: "/api/me", auth: grace, body: { displayName } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("60 characters") } });
    }
    expect((await callRoute(routes, { method: "PUT", path: "/api/me", auth: grace, body: { displayName: 7 } })).status).toBe(400);
    expect((await callRoute(routes, { method: "PUT", path: "/api/me", auth: grace, body: {} })).status).toBe(400);
    expect((await callRoute(routes, { method: "DELETE", path: "/api/me", auth: grace })).status).toBe(405);
    expect((await callRoute(routes, { method: "GET", path: "/api/me", auth: grace })).body.displayName).toBe("");
  });

  it("has nothing for the owner's own computer, which goes by the profile, nor any welcome off a team", async () => {
    const routes = setup();
    expect((await callRoute(routes, { method: "GET", path: "/api/me", auth: owner })).status).toBe(404);
    expect((await callRoute(routes, { method: "PUT", path: "/api/me", auth: owner, body: { displayName: "Ada" } })).status).toBe(404);
    expect((await callRoute(routes, { method: "PUT", path: "/api/me/welcome", auth: signedIn(session("s1")), body: { welcomed: true } })).status).toBe(404);
  });

  it("answers 404 where no names are kept, such as a Cloud home", async () => {
    const { routes } = selfHosted(null);
    expect((await callRoute(routes, { method: "GET", path: "/api/me", auth: signedIn(session("s1")) })).status).toBe(404);
  });
});
