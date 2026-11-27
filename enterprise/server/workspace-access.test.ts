// Real HTTP, cookies and SessionRegistry; only the configured HTTPS portal's
// backchannel is substituted. No provider accounts, public DNS or live data.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type Scope } from "../../server/sessions.ts";
import { hostedWorkspaceConfiguration } from "../../server/enterprise.ts";
import { resolveRequestAuth } from "../../server/request-auth.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { createWorkspaceAccess } from "./workspace-access.ts";
import { HOSTED_CONTRACT_VERSION } from "../../server/hosted-contract.ts";

const env = { OMB_ADMIN_URL: "https://admin.example.test", OMB_ADMIN_WORKSPACE: "acme", OMB_PUBLIC_URL: "https://acme.example.test" };
const email = "member@example.test";
const proof = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
let home: string;
let sessions: SessionRegistry;
let localScopes: Scope[] | null;
let clock: number;
let licensed: boolean;
let member: { email: string; role: "admin" | "member" } | null;
let outage: boolean;
let contractVersion: unknown;
let codes: Map<string, { workspace: string; challenge: string }>;
let grants: Set<string>;
let server: ReturnType<typeof createServer>;
let port: number;
let access: ReturnType<typeof createWorkspaceAccess>;
let streams: Map<string, ServerResponse>;
const closed = vi.fn();
const remote = vi.fn<typeof fetch>();

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-hosted-access-"));
  clock = Date.now(); licensed = true; outage = false;
  contractVersion = HOSTED_CONTRACT_VERSION;
  localScopes = ["admin", "client"]; member = { email, role: "admin" };
  codes = new Map(); grants = new Set(); streams = new Map();
  sessions = new SessionRegistry({ file: join(home, "sessions.json"), emailScopes: () => localScopes });
  closed.mockReset().mockImplementation((id: string) => streams.get(id)?.end());
  sessions.onSessionRevoked(closed);
  remote.mockReset().mockImplementation(async (url, init) => {
    expect(new URL(String(url)).origin).toBe(env.OMB_ADMIN_URL);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", headers: { "content-type": "application/json" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (outage) throw new Error("PRIVATE upstream failure");
    const body = JSON.parse(String(init?.body));
    expect(body.workspace).toBe("acme");
    expect(body.contractVersion).toBe(HOSTED_CONTRACT_VERSION);
    if (String(url).endsWith("/consume")) {
      const code = codes.get(body.code);
      if (!member || !code || code.workspace !== body.workspace || code.challenge !== digest(body.verifier)) return Response.json({}, { status: 401 });
      codes.delete(body.code);
      const grant = proof(); grants.add(grant);
      return Response.json({ ...member, grant, contractVersion });
    }
    return member && grants.has(body.grant) ? Response.json({ ...member, contractVersion }) : Response.json({}, { status: 401 });
  });
  access = createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams: closed, entitled: () => licensed, env, now: () => clock, fetchImpl: remote });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, env.OMB_PUBLIC_URL);
    if (await access.handlePublic(req, res, url)) return;
    const gate = resolveRequestAuth(req, { sessions, cookieName: "session", streamPath: "/api/events", url });
    const failure = gate.auth ? await access.authorize(req, gate.auth) : gate;
    if (failure) { res.writeHead(failure.status); res.end(); return; }
    if (url.pathname === "/api/events" && gate.auth?.kind === "session") {
      streams.set(gate.auth.session.id, res);
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); return;
    }
    res.writeHead(200); res.end(JSON.stringify(gate.auth?.scopes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  for (const stream of streams.values()) stream.end();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(home);
});

function call(path: string, cookie?: string, host = "acme.example.test", forwardedFor = "203.0.113.7") {
  return new Promise<{ status: number; cookies: string[]; location: string; body: string; retryAfter?: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers: { host, "x-forwarded-for": forwardedFor, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = ""; res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, cookies: res.headers["set-cookie"] ?? [], location: res.headers.location ?? "", body, retryAfter: res.headers["retry-after"] }));
    });
    req.on("error", reject); req.end();
  });
}
async function begin(workspace = "acme") {
  const start = await call("/api/auth/hosted/start");
  expect(start.status).toBe(302);
  const target = new URL(start.location);
  expect(target.origin + target.pathname).toBe(`${env.OMB_ADMIN_URL}/connect`);
  expect(target.searchParams.get("workspace")).toBe("acme");
  const state = target.searchParams.get("state")!;
  const code = proof(); codes.set(code, { workspace, challenge: target.searchParams.get("challenge")! });
  const cookie = start.cookies[0].split(";")[0];
  expect(start.cookies[0]).toMatch(/^__Host-session_handoff=/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=300"]) expect(start.cookies[0]).toContain(flag);
  expect(start.cookies[0]).not.toContain("Domain=");
  return { cookie, callback: `/api/auth/hosted/callback?state=${state}&code=${code}`, code };
}
async function login() {
  const pending = await begin();
  const reply = await call(pending.callback, pending.cookie);
  expect(reply.status).toBe(302); expect(reply.location).toBe("/");
  expect(reply.cookies[0]).toContain("Max-Age=0");
  const cookie = reply.cookies.find((value) => value.startsWith("session="))!.split(";")[0];
  const session = sessions.authenticate(cookie.slice("session=".length))!;
  expect(session.userId).toMatch(/^portal:/);
  return { cookie, session };
}

describe("hosted workspace handoff and continuous access", () => {
  it("redirects the root and pairing page; exchanges PKCE once for a normal scoped session", async () => {
    expect((await call("/")).location).toBe("/api/auth/hosted/start");
    expect((await call("/pair")).location).toBe("/api/auth/hosted/start");
    const { cookie } = await login();
    expect((await call("/api/auth/session", cookie)).body).toBe('["admin","client"]');
    expect((await call("/", cookie)).status).toBe(200);
  });
  it("supports the legacy-v1 unversioned response without dropping its own explicit request version", async () => {
    contractVersion = undefined;
    const { cookie } = await login();
    expect((await call("/api/auth/session", cookie)).status).toBe(200);
    expect(remote).toHaveBeenCalledTimes(2);
  });
  it.each([2, 0, "1", null, [1]].map(version => ({ version })))("rejects incompatible consume version $version without issuing a session or downgrading", async ({ version }) => {
    contractVersion = version;
    const pending = await begin();
    const response = await call(pending.callback, pending.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toContain("versions are incompatible");
    expect(response.cookies.some(cookie => cookie.startsWith("session="))).toBe(false);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it("reports an explicit Admin version rejection without replaying a consumed callback", async () => {
    const pending = await begin();
    remote.mockResolvedValueOnce(Response.json({ error: "PRIVATE incompatible deployment details" }, { status: 409 }));
    const response = await call(pending.callback, pending.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toContain("versions are incompatible");
    expect(response.body).not.toContain("PRIVATE");
    expect((await call(pending.callback, pending.cookie)).status).toBe(400);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it("closes an idle stream on a version mismatch, preserving the grant for compatible recovery", async () => {
    const { cookie, session } = await login();
    const response = await new Promise<IncomingMessage>(resolve => request({ hostname: "127.0.0.1", port, path: "/api/events", headers: { host: "acme.example.test", cookie, "x-forwarded-for": "203.0.113.7" } }, resolve).end());
    expect(response.statusCode).toBe(200); response.resume();
    const ended = new Promise<void>(resolve => response.on("end", resolve));
    contractVersion = 2;
    await access.revalidate(); await ended;
    expect((await call("/api/auth/session", cookie)).status).toBe(503);
    expect(sessions.isLive(session.id)).toBe(true);
    contractVersion = HOSTED_CONTRACT_VERSION;
    expect((await call("/api/auth/session", cookie)).status).toBe(200);
  });
  it("rejects state/cookie mismatch, expiry, duplicate params, replay and wrong-workspace codes", async () => {
    const pending = await begin();
    for (const [path, cookie] of [[pending.callback, ""], [pending.callback, `${pending.cookie}wrong`], [pending.callback + "&state=other", pending.cookie]]) {
      expect((await call(path, cookie)).status).toBe(400);
    }
    expect(remote).not.toHaveBeenCalled();
    expect((await call(pending.callback, pending.cookie)).status).toBe(302);
    expect((await call(pending.callback, pending.cookie)).status).toBe(400);
    const wrong = await begin("other");
    expect((await call(wrong.callback, wrong.cookie)).status).toBe(401);
    const reused = await begin();
    expect((await call(reused.callback.replace(reused.code, pending.code), reused.cookie)).status).toBe(401);
    const expired = await begin(); clock += 300_001;
    expect((await call(expired.callback, expired.cookie)).status).toBe(400);
  });
  it("binds both public and authenticated routes to the tenant Host", async () => {
    expect((await call("/api/auth/hosted/start", undefined, "wrong.example.test")).status).toBe(403);
    const { cookie, session } = await login();
    expect((await call("/api/auth/session", cookie, "wrong.example.test")).status).toBe(403);
    expect(sessions.isLive(session.id)).toBe(true);
  });
  it("consumes local state before awaiting the portal, rejecting concurrent callback replay", async () => {
    const pending = await begin();
    let finish!: (response: Response) => void;
    remote.mockImplementationOnce(() => new Promise((resolve) => finish = resolve));
    const first = call(pending.callback, pending.cookie);
    await expect.poll(() => remote.mock.calls.length).toBe(1);
    expect((await call(pending.callback, pending.cookie)).status).toBe(400);
    finish(Response.json({ ...member, grant: proof() }));
    expect((await first).status).toBe(302);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it("rate-limits starts by the trusted source without clearing a pending cookie or blocking its callback", async () => {
    const pending = await begin();
    for (let index = 1; index < 20; index++) expect((await call("/api/auth/hosted/start")).status).toBe(302);
    const rejected = await call("/api/auth/hosted/start", pending.cookie, "acme.example.test", "198.51.100.80, 203.0.113.7");
    expect(rejected).toMatchObject({ status: 429, cookies: [], location: "", retryAfter: "60" });
    expect((await call("/api/auth/hosted/start", "different-cookie", "acme.example.test", "198.51.100.81, 203.0.113.7")).status).toBe(429);
    expect((await call("/api/auth/hosted/start", undefined, "acme.example.test", "203.0.113.8")).status).toBe(302);
    expect(remote).not.toHaveBeenCalled();
    expect((await call(pending.callback, pending.cookie)).status).toBe(302);
    clock += 60_000;
    expect((await call("/api/auth/hosted/start")).status).toBe(302);
  });
  it("rejects global capacity without evicting the oldest handoff, and reclaims completed and expired slots", async () => {
    const pending = await begin();
    for (let index = 0; index < 999; index++) {
      const source = `198.51.100.${Math.floor(index / 20) + 1}`;
      expect((await call("/api/auth/hosted/start", undefined, "acme.example.test", source)).status).toBe(302);
    }
    const rejected = await call("/api/auth/hosted/start", pending.cookie, "acme.example.test", "192.0.2.1");
    expect(rejected).toMatchObject({ status: 429, cookies: [], location: "", retryAfter: "60" });
    expect(remote).not.toHaveBeenCalled();
    expect((await call(pending.callback, pending.cookie)).status).toBe(302);
    expect((await call("/api/auth/hosted/start", undefined, "acme.example.test", "192.0.2.1")).status).toBe(302);
    expect((await call("/api/auth/hosted/start", undefined, "acme.example.test", "192.0.2.2")).status).toBe(429);
    clock += 300_000;
    expect((await call("/api/auth/hosted/start", undefined, "acme.example.test", "192.0.2.2")).status).toBe(302);
  });
  it("rejects nonportal remote sessions while preserving credential-free local owner access", async () => {
    const paired = sessions.issue({ label: "QR device", scopes: ["admin", "client"] });
    expect((await call("/api/auth/session", `session=${paired.token}`)).status).toBe(401);
    expect(sessions.isLive(paired.session.id)).toBe(true);
    expect(await access.authorize({} as IncomingMessage, { kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
  it.each(["removed", "demoted", "email changed"])("revokes an issued session when membership is %s", async (change) => {
    const { cookie, session } = await login();
    const ticket = sessions.issueStreamTicket(session.id);
    if (change === "removed") member = null;
    if (change === "demoted") member!.role = "member";
    if (change === "email changed") member!.email = "someone-else@example.test";
    expect((await call("/api/auth/session", cookie)).status).toBe(401);
    expect(sessions.isLive(session.id)).toBe(false);
    expect(sessions.redeemStreamTicket(ticket.ticket)).toBeNull();
    expect(closed).toHaveBeenCalledWith(session.id);
  });
  it("checks local membership too and never promotes an existing client session", async () => {
    member!.role = "member"; localScopes = ["client"];
    const { cookie, session } = await login();
    member!.role = "admin"; localScopes = ["admin", "client"];
    expect((await call("/api/auth/session", cookie)).body).toBe('["client"]');
    localScopes = null;
    expect((await call("/api/auth/session", cookie)).status).toBe(401);
    expect(sessions.isLive(session.id)).toBe(false);
    const pending = await begin();
    expect((await call(pending.callback, pending.cookie)).status).toBe(403);
  });
  it("fails closed during an outage, closes streams, but permits recovery without revoking the session", async () => {
    const { cookie, session } = await login();
    outage = true;
    expect((await call("/api/auth/session", cookie)).status).toBe(503);
    expect(closed).toHaveBeenCalledWith(session.id);
    expect(sessions.isLive(session.id)).toBe(true);
    outage = false;
    expect((await call("/api/auth/session", cookie)).status).toBe(200);
  });
  it("lets only verified portal grants use portal membership and still enforces outage, demotion and stream revocation", async () => {
    const portalEnv = { ...env, OMB_ADMIN_MEMBERSHIP: "portal" };
    localScopes = null;
    sessions = new SessionRegistry({ file: join(home, "sessions.json"), emailScopes: () => localScopes, portalMembership: hostedWorkspaceConfiguration(portalEnv)?.portalMembership === true });
    sessions.onSessionRevoked(closed);
    access = createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams: closed, entitled: () => licensed, env: portalEnv, now: () => clock, fetchImpl: remote });
    const { cookie, session } = await login();
    expect(session.membershipAuthority).toBe("portal");
    expect((await call("/api/auth/session", cookie)).body).toBe('["admin","client"]');
    const ordinary = sessions.issue({ label: "ordinary email", email, userId: session.userId, scopes: ["admin", "client"] });
    expect((await call("/api/auth/session", `session=${ordinary.token}`)).status).toBe(401);
    outage = true;
    expect((await call("/api/auth/session", cookie)).status).toBe(503);
    expect(sessions.isLive(session.id)).toBe(true);
    outage = false; member!.role = "member";
    expect((await call("/api/auth/session", cookie)).status).toBe(401);
    const current = await login();
    expect(current.session.scopes).toEqual(["client"]);
    const response = await new Promise<IncomingMessage>(resolve => request({ hostname: "127.0.0.1", port, path: "/api/events", headers: { host: "acme.example.test", cookie: current.cookie, "x-forwarded-for": "203.0.113.7" } }, resolve).end());
    expect(response.statusCode).toBe(200); response.resume();
    const ended = new Promise<void>(resolve => response.on("end", resolve));
    member = null; await access.revalidate(); await ended;
    expect((await call("/api/auth/session", current.cookie)).status).toBe(401);
  });
  it("periodic revalidation closes an already open, otherwise idle HTTP event stream", async () => {
    const { cookie } = await login();
    const response = await new Promise<IncomingMessage>((resolve) => request({ hostname: "127.0.0.1", port, path: "/api/events", headers: { host: "acme.example.test", cookie, "x-forwarded-for": "203.0.113.7" } }, resolve).end());
    expect(response.statusCode).toBe(200);
    response.resume();
    const ended = new Promise<void>((resolve) => response.on("end", resolve));
    member = null;
    await access.revalidate();
    await ended;
    expect((await call("/api/auth/session", cookie)).status).toBe(401);
  });
  it("bounds a stalled backchannel at five seconds and preserves the session", async () => {
    const { cookie, session } = await login();
    remote.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const started = Date.now();
    expect((await call("/api/auth/session", cookie)).status).toBe(503);
    expect(Date.now() - started).toBeLessThan(6_500);
    expect(sessions.isLive(session.id)).toBe(true);
    expect(closed).toHaveBeenCalledWith(session.id);
  }, 7_000);
  it.each([
    { OMB_ADMIN_URL: "http://admin.example.test" }, { OMB_ADMIN_URL: "https://admin.example.test/path/.." },
    { OMB_ADMIN_URL: "https://user:secret@admin.example.test" }, { OMB_ADMIN_WORKSPACE: "" },
    { OMB_PUBLIC_URL: "https://acme.example.test/?redirect=evil" },
    { OMB_ADMIN_MEMBERSHIP: "invalid" },
  ])("fails closed with invalid configuration: %j", async (patch) => {
    access = createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams: closed, entitled: () => true, env: { ...env, ...patch }, fetchImpl: remote });
    expect((await call("/api/auth/hosted/start")).status).toBe(503);
    expect(remote).not.toHaveBeenCalled();
  });
  it("requires a live enterprise Admin entitlement without blocking the local owner", async () => {
    const { cookie } = await login(); licensed = false;
    expect((await call("/api/auth/hosted/start")).status).toBe(503);
    expect((await call("/api/auth/session", cookie)).status).toBe(503);
    expect(await access.authorize({} as IncomingMessage, { kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
});
