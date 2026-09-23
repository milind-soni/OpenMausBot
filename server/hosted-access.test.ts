// Owned full server, disposable data, dynamically loaded enterprise hook.
// The HTTPS backchannel is injected, never redirected to a real portal.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { SessionRegistry } from "./sessions.ts";
import { HOSTED_CONTRACT_HEADER, HOSTED_CONTRACT_METADATA } from "./hosted-contract.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 35000 + Math.floor(Math.random() * 5000);
const HOST = "acme.example.test";
const EMAIL = "member@example.test";
const INSTANCES = { fixture: { driver: "hosted-access-test-shadow" }, claude: {
  driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
} };
let home: string;
let stateFile: string;
let child: ChildProcess;
let log = "";
let pairedToken: string;
let fixtureEnv: NodeJS.ProcessEnv;
let policyBotId: string | undefined;
const policyEvidence: unknown[] = [];
const state = (role: string | null = "admin", outage = false, license: { features?: string[]; expiresAt?: string; invalid?: boolean } = {}) => writeFileSync(stateFile, JSON.stringify({ role, outage, license }));

function call(path: string, options: { method?: string; cookie?: string; token?: string; local?: boolean; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any; cookies: string[]; location?: string; contractVersion?: string | string[] }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path, method: options.method ?? "GET", headers: {
      ...(options.local ? {} : { host: HOST, "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" }),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    } }, (res) => {
      let raw = ""; res.on("data", (chunk) => raw += chunk);
      res.on("end", () => { let body: unknown = raw; try { body = JSON.parse(raw); } catch { /* static HTML */ }
        resolve({ status: res.statusCode!, body, cookies: res.headers["set-cookie"] ?? [], location: res.headers.location, contractVersion: res.headers[HOSTED_CONTRACT_HEADER] }); });
    });
    req.on("error", reject); req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
async function policyBot() {
  if (policyBotId) return policyBotId;
  const catalog = await call("/api/instances", { local: true });
  const provider = catalog.body.instances.find((instance: any) => instance.instanceId === "claude");
  expect(provider.driverKind).toBe("claudeAgent");
  expect(provider.snapshot.state).not.toBe("unavailable");
  expect(provider.cli).toBe(INSTANCES.claude.config.cli);
  const created = await call("/api/bots", { method: "POST", local: true, body: {
    name: "Hosted policy fixture", requireAvailableModel: true, modelSelection: { instanceId: "claude", model: provider.models.default },
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return policyBotId = created.body.bot.id as string;
}
async function policyHealth(enabled: boolean, cookie?: string) {
  const health = await call("/api/health", cookie ? { cookie } : { local: true });
  expect(health.status).toBe(200);
  expect(health.body.capabilities.guardedFullAccess).toBe(1);
  expect(health.body.capabilities.sharedWorkspaceFullAccess).toBe(enabled ? 1 : undefined);
  policyEvidence.push({ health: health.body, authenticatedAs: cookie ? "portal session" : "loopback" });
}
async function refuseFullTask(cookie?: string) {
  const botId = await policyBot();
  const bots = async () => (await call("/api/bots?messages=0", { local: true })).body.bots;
  const before = (await bots()).find((bot: any) => bot.id === botId);
  const denied = await call(`/api/bots/${botId}/tasks`, { method: "POST", ...(cookie ? { cookie } : { local: true }),
    body: { title: "Must not become Full", approvalMode: "full" } });
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect((await bots()).find((bot: any) => bot.id === botId)).toEqual(before);
  policyEvidence.push({ deniedFullTask: denied.body, status: denied.status, authenticatedAs: cookie ? "portal session" : "loopback" });
}
async function login() {
  const start = await call("/api/auth/hosted/start");
  expect(start.status).toBe(302);
  const state = new URL(start.location!).searchParams.get("state");
  const callback = await call(`/api/auth/hosted/callback?state=${state}&code=${"c".repeat(43)}`, { cookie: start.cookies[0].split(";")[0] });
  expect(callback.status).toBe(302);
  return callback.cookies.find((value) => !value.startsWith("__Host-"))!.split(";")[0];
}
async function restart(env: NodeJS.ProcessEnv = {}) {
  await waitForExit(child, { signal: "SIGTERM" });
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: { ...fixtureEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk); child.stderr?.on("data", (chunk) => log += chunk);
  await expect.poll(async () => {
    try { return (await call("/api/health", { local: true })).status; } catch { return 0; }
  }, { timeout: 20_000 }).toBe(200);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-hosted-server-"));
  stateFile = join(home, "portal-fixture.json"); state();
  const data = join(home, ".openmausbot");
  const layer = join(home, "enterprise");
  mkdirSync(join(layer, "server"), { recursive: true });
  mkdirSync(join(home, "static"));
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Fixture workspace</title>");
  const sessions = new SessionRegistry({ file: join(data, "sessions.json") });
  pairedToken = sessions.issue({ label: "Pre-existing QR device", scopes: ["admin", "client"] }).token;
  writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: [EMAIL] }, instances: INSTANCES }));
  writeFileSync(join(layer, "server", "index.ts"), `
    import { readFileSync } from 'node:fs';
    import { createWorkspaceAccess as create } from ${JSON.stringify(pathToFileURL(join(ROOT, "enterprise/server/workspace-access.ts")).href)};
    export function register() {
      const { license } = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
      if (license.invalid) throw new Error('invalid fixture license');
      return { customer: 'Fixture', features: license.features ?? ['admin'], expiresAt: license.expiresAt ?? null };
    }
    export function createWorkspaceAccess(options) {
      return create({ ...options, fetchImpl: async (url, init) => {
        if (new URL(url).origin !== 'https://admin.example.test') throw new Error('unexpected outbound origin');
        const current = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
        if (current.outage) throw new Error('offline fixture');
        const body = JSON.parse(init.body);
        if (body.workspace !== 'acme' || !current.role) return Response.json({}, { status: 401 });
        return Response.json({ email: ${JSON.stringify(EMAIL)}, role: current.role, grant: 'g'.repeat(43) });
      } });
    }
  `);
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: fixtureEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
    OMB_STATIC_DIR: join(home, "static"), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
    OMB_ENTERPRISE_DIR: layer, OMB_LICENSE_KEY: "fixture-only", OMB_ADMIN_URL: "https://admin.example.test",
    OMB_ADMIN_WORKSPACE: "acme", OMB_PUBLIC_URL: `https://${HOST}`,
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk); child.stderr?.on("data", (chunk) => log += chunk);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await call("/api/health", { local: true })).status === 200) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned hosted fixture failed to start:\n${log}`);
}, 30_000);
afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `hosted-access-${Date.now()}-${process.pid}.log`);
  writeFileSync(logPath, log);
  writeFileSync(`${logPath}.json`, JSON.stringify(policyEvidence, null, 2));
  console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.json` }));
  await removeTempDir(home);
});

describe("hosted bridge in the full server", () => {
  it("loads the optional hook before listening, redirects hosted navigation, and disables legacy sign-in", async () => {
    expect(log).toContain("enterprise edition for Fixture");
    expect((await call("/")).location).toBe("/api/auth/hosted/start");
    expect((await call("/pair")).location).toBe("/api/auth/hosted/start");
    expect((await call("/", { local: true })).body).toContain("Fixture workspace");
    expect((await call("/.well-known/openmausbot/environment")).body.capabilities.emailSignIn).toBe(false);
    for (const path of ["/api/auth/pair", "/api/auth/pairing", "/api/auth/email/start", "/api/auth/email/verify"]) {
      expect((await call(path, { method: "POST" })).status).toBe(403);
    }
    expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(401);
    expect((await call("/api/auth/session", { local: true })).body.kind).toBe("loopback");
    expect((await call("/api/health/hosted")).status).toBe(503);
  });
  it("accepts a portal session, enforces outages/demotion, and issues only current permissions on reauthentication", async () => {
    const cookie = await login();
    expect((await call("/api/auth/session", { cookie })).body.scopes).toEqual(["admin", "client"]);
    expect((await call("/", { cookie })).body).toContain("Fixture workspace");
    state("admin", true);
    expect((await call("/api/auth/session", { cookie })).status).toBe(503);
    state();
    expect((await call("/api/auth/session", { cookie })).status).toBe(200);
    state("member");
    expect((await call("/api/auth/session", { cookie })).status).toBe(401);
    const memberCookie = await login();
    expect((await call("/api/auth/session", { cookie: memberCookie })).body.scopes).toEqual(["client"]);
    expect((await call("/api/auth/sessions", { cookie: memberCookie })).status).toBe(403);
  });
  it("closes an existing quiet event stream within fifteen seconds of remote revocation", async () => {
    state();
    const cookie = await login();
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/events", headers: { host: HOST, cookie, "x-forwarded-for": "203.0.113.8" } }, resolve);
      req.on("error", reject); req.end();
    });
    expect(response.statusCode).toBe(200); response.resume();
    const revokedAt = Date.now();
    const ended = new Promise<void>((resolve) => response.on("end", resolve));
    state(null);
    await ended;
    expect(Date.now() - revokedAt).toBeLessThan(15_000);
    expect((await call("/api/auth/session", { cookie })).status).toBe(401);
  }, 17_000);
  it("grants only new local Full tasks under the explicit hosted policy and preserves defaults and existing tasks", async () => {
    state();
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal" });
    await policyHealth(false);
    await refuseFullTask();
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" });
    await policyHealth(true);
    const cookie = await login();
    expect((await call("/api/auth/session", { cookie })).body.scopes).toEqual(["admin", "client"]);
    await policyHealth(true, cookie);
    await refuseFullTask(cookie);
    const botId = await policyBot();
    expect((await call(`/api/bots/${botId}`, { method: "PATCH", local: true,
      body: { approvalMode: "auto", acknowledgeLocalAuto: true, alwaysAllow: ["Bash:fixture-only"] } })).status).toBe(200);
    const before = (await call("/api/bots?messages=0", { local: true })).body.bots.find((bot: any) => bot.id === botId);
    let existingTasks = before.tasks;
    for (const approvalMode of ["full", "ask"] as const) {
      const created = await call(`/api/bots/${botId}/tasks`, { method: "POST", local: true,
        body: { title: `Explicit ${approvalMode} fixture`, approvalMode } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.task).toMatchObject({ approvalMode, autoApprove: false, alwaysAllow: [] });
      expect(created.body.bot).toMatchObject({ approvalMode: "auto", autoApprove: true, alwaysAllow: ["Bash:fixture-only"] });
      for (const task of existingTasks) expect(created.body.bot.tasks.find((candidate: any) => candidate.threadId === task.threadId)).toEqual(task);
      existingTasks = created.body.bot.tasks;
      policyEvidence.push({ newTask: created.body.task, botDefaults: { approvalMode: created.body.bot.approvalMode, autoApprove: created.body.bot.autoApprove, alwaysAllow: created.body.bot.alwaysAllow } });
    }
    const unsupported = await call("/api/bots", { method: "POST", local: true,
      body: { name: "Unavailable provider fixture", modelSelection: { instanceId: "fixture", model: "fixture-only" } } });
    expect(unsupported.status).toBe(201);
    const rejected = await call(`/api/bots/${unsupported.body.bot.id}/tasks`, { method: "POST", local: true,
      body: { title: "Unsupported Full", approvalMode: "full" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("provider does not support Full");
  }, 30_000);
  it("fails closed if a configured deployment loses its enterprise hook, with local owner access retained", async () => {
    await restart({ OMB_ENTERPRISE_DIR: join(home, "absent-layer"), OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" });
    await policyHealth(false);
    await refuseFullTask();
    expect((await call("/api/health/hosted")).status).toBe(503);
    expect((await call("/api/auth/hosted/start")).status).toBe(503);
    expect((await call("/")).status).toBe(503);
    expect((await call("/pair")).status).toBe(503);
    expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(503);
    expect((await call("/api/auth/email/verify", { method: "POST" })).status).toBe(403);
    expect((await call("/api/auth/session", { local: true })).body.kind).toBe("loopback");
  }, 25_000);
  it("uses explicit portal membership without local allow-list synchronization and still revokes quiet streams", async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    state();
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ signIn: { admins: [], members: [] }, instances: INSTANCES }));
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: { ...fixtureEnv, OMB_ADMIN_MEMBERSHIP: "portal" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr?.on("data", (chunk) => log += chunk);
    await expect.poll(async () => {
      try { return (await call("/api/health", { local: true })).status; } catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);
    const readiness = await call("/api/health/hosted");
    expect(readiness.status).toBe(200);
    expect(readiness.body).toEqual({ ok: true, service: "openmausbot", membershipAuthority: "portal", workspace: "acme", ...HOSTED_CONTRACT_METADATA });
    expect(readiness.contractVersion).toBe("1");
    expect(readiness.cookies).toEqual([]);
    const cookie = await login();
    expect((await call("/api/auth/session", { cookie })).body.scopes).toEqual(["admin", "client"]);
    expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(401);
    state("admin", true);
    expect((await call("/api/auth/session", { cookie })).status).toBe(503);
    state("member");
    expect((await call("/api/auth/session", { cookie })).status).toBe(401);
    const memberCookie = await login();
    expect((await call("/api/auth/session", { cookie: memberCookie })).body.scopes).toEqual(["client"]);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/events", headers: { host: HOST, cookie: memberCookie, "x-forwarded-for": "203.0.113.8" } }, resolve);
      req.on("error", reject); req.end();
    });
    expect(response.statusCode).toBe(200); response.resume();
    const ended = new Promise<void>(resolve => response.on("end", resolve));
    const revokedAt = Date.now(); state(null); await ended;
    expect(Date.now() - revokedAt).toBeLessThan(15_000);
    expect((await call("/api/auth/session", { cookie: memberCookie })).status).toBe(401);
  }, 30_000);
  it.each([
    ["standalone", { OMB_ADMIN_URL: undefined, OMB_ADMIN_WORKSPACE: undefined, OMB_ADMIN_MEMBERSHIP: undefined }],
    ["incomplete hosted configuration", { OMB_ADMIN_URL: undefined, OMB_ADMIN_MEMBERSHIP: "portal" }],
    ["invalid workspace", { OMB_ADMIN_WORKSPACE: "../private", OMB_ADMIN_MEMBERSHIP: "portal" }],
    ["invalid membership mode", { OMB_ADMIN_MEMBERSHIP: "invalid" }],
    ["local membership mode", { OMB_ADMIN_MEMBERSHIP: "local" }],
  ] satisfies [string, NodeJS.ProcessEnv][])("does not attest portal readiness for %s", async (_name, env) => {
    state();
    await restart(env);
    const readiness = await call("/api/health/hosted");
    expect(readiness.status).toBe(503);
    expect(readiness.contractVersion).toBeUndefined();
    expect(readiness.body).toEqual({ error: "Hosted workspace readiness is unavailable." });
    expect((await call("/api/health")).status).toBe(200);
  }, 25_000);
  it.each([
    ["invalid license", { invalid: true }, {}],
    ["missing admin entitlement", { features: [] }, {}],
    ["missing license", {}, { OMB_LICENSE_KEY: undefined }],
  ] satisfies [string, Parameters<typeof state>[2], NodeJS.ProcessEnv][])("does not attest portal readiness without valid admin entitlement (%s)", async (_name, license, env) => {
    state("admin", false, license);
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1", ...env });
    expect((await call("/api/health/hosted")).status).toBe(503);
    expect((await call("/api/health")).status).toBe(200);
    await policyHealth(false);
    await refuseFullTask();
  }, 25_000);
  it("withdraws hosted readiness immediately when the running server's entitlement expires", async () => {
    state("admin", false, { expiresAt: new Date(Date.now() + 8_000).toISOString() });
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" });
    expect((await call("/api/health/hosted")).status).toBe(200);
    await policyHealth(true);
    await expect.poll(async () => (await call("/api/health/hosted")).status, { timeout: 10_000, interval: 100 }).toBe(503);
    expect((await call("/api/health")).status).toBe(200);
    await policyHealth(false);
    await refuseFullTask();
  }, 30_000);
  it("never activates the shared Full policy in a desktop-managed process", async () => {
    state();
    await policyBot();
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1", OMB_DESKTOP_PARENT: "1" });
    await policyHealth(false);
    await refuseFullTask();
  }, 25_000);
  it("offers the Slack management link for real agents to hosted admins and members, without sharing credentials", async () => {
    state();
    await restart({ OMB_ADMIN_MEMBERSHIP: "portal" });
    const botId = await policyBot();
    const path = `/api/bots/${botId}/slack-management`;
    const cookie = await login();
    const management = await call(path, { cookie });
    expect(management.status).toBe(200);
    expect(management.body).toEqual({ available: true,
      managementUrl: `https://admin.example.test/slack?workspace=acme&bot=${botId}` });
    expect((await call("/api/bots/missing-agent/slack-management", { cookie })).status).toBe(404);
    expect((await call(`/api/bots/${botId}`, { local: true, method: "PATCH", body: { hidden: true } })).status).toBe(200);
    expect((await call(path, { cookie })).status).toBe(404);
    expect((await call(`/api/bots/${botId}`, { local: true, method: "PATCH", body: { hidden: false } })).status).toBe(200);
    state("member");
    expect((await call(path, { cookie })).status).toBe(401);
    // A member reads Bot Settings too: same link, and Admin decides what its visitor may do.
    const memberCookie = await login();
    expect((await call("/api/auth/session", { cookie: memberCookie })).body.scopes).toEqual(["client"]);
    const asMember = await call(path, { cookie: memberCookie });
    expect(asMember.status).toBe(200);
    expect(asMember.body).toEqual(management.body);
    expect((await call(path, { cookie: memberCookie, method: "POST", body: {} })).status).toBe(403);
    // No credential at all: the gate refuses a remote stranger before the route table runs.
    const stranger = await call(path);
    expect(stranger.status).toBe(403);
    expect(JSON.stringify(stranger.body)).not.toContain("admin.example.test");
    state();
    await restart({ OMB_ADMIN_MEMBERSHIP: "local" });
    expect((await call(path, { local: true })).body).toEqual({ available: false });
    policyEvidence.push({ slackManagement: management.body, memberStatus: asMember.status, localMembershipAvailable: false });
  }, 30_000);
});
