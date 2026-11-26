// The native Antigravity CLI through the server's own instance routes, with a real registry and driver and a fake CLI
// on disk: the sign-in, the status, a turn, the check and the sign-out the app offers, and removing the account.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { antigravityProfileDirectory } from "../drivers/antigravity-acp.ts";
import { AntigravityDriver } from "../drivers/antigravity.ts";
import { ENGINE_LIST_REUSE_MS, ProviderRegistry } from "../harness/registry.ts";
import { json, readBody } from "../harness/http.ts";
import { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { nativeFixture, loginAt } from "../testing/antigravity-native-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { dispatchRoutes } from "./table.ts";

const WINDOWS = process.platform === "win32";
const servers: Server[] = [];
const scratch: string[] = [];
const registries: ProviderRegistry[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const registry of registries.splice(0)) await registry.disposeAll();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-routes-"));
  scratch.push(directory);
  return directory;
}

async function serve(registry: ProviderRegistry, cfg: AppConfig, extra: Partial<InstanceRouteDeps> = {}) {
  registries.push(registry);
  let busy = false;
  const persisted: InstanceConfigMap[] = [];
  const deps = {
    store: { bots: [], tasks: () => [] },
    cfg,
    registry,
    sessions: { isLive: () => true },
    providerAuthSessions: new ProviderAuthSessions(),
    hostedModels: false,
    providerConfigBusy: { get: () => busy, set: (value: boolean) => { busy = value; } },
    providerInstancesChanging: new Set<string>(),
    describeInstances: () => registry.describe(),
    persistProviderInstance: async (_id: string, instances: InstanceConfigMap) => {
      await new Promise((resolve) => setImmediate(resolve));
      cfg.instances = instances;
      persisted.push(structuredClone(instances));
    },
    threadBusy: () => false,
    botForThread: () => null,
    activeGroupTurnForBot: () => null,
    ...extra,
  } as unknown as InstanceRouteDeps;
  const routes = [createInstanceRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const answered = await request(method, path, body);
    expect(answered.status, `${method} ${path} ${JSON.stringify(answered.body)}`).toBe(200);
    return answered.body;
  };
  const status = async (instanceId: string) => (await call("GET", "/api/instances?fresh=1")).instances.find((entry: any) => entry.instanceId === instanceId).snapshot;
  return { request, call, status, persisted, setBusy: (value: boolean) => { busy = value; } };
}

async function nativeSetup(extraIds: string[] = [], environment: Record<string, string> = {}) {
  const fixture = nativeFixture(folder());
  const entry = { driver: "antigravityAgent", config: { cli: fixture.executable }, environment: { FAKE_AGY_LOG: fixture.log, ...environment } };
  const instances = { antigravity: entry, ...Object.fromEntries(extraIds.map((id) => [id, structuredClone(entry)])) } as InstanceConfigMap;
  const cfg = { instances: structuredClone(instances) } as unknown as AppConfig;
  const registry = new ProviderRegistry([AntigravityDriver]);
  await registry.load(instances);
  return { fixture, cfg, registry };
}

describe.skipIf(WINDOWS)("the native Antigravity CLI through the instance routes", () => {
  it("signs in, reports signed in with the account's models, runs a turn, and signs out, from the UI's own calls", async () => {
    const { fixture, cfg, registry } = await nativeSetup();
    const { call, status } = await serve(registry, cfg);

    expect(await status("antigravity")).toMatchObject({ state: "available", authenticated: false });

    const started = (await call("POST", "/api/instances/antigravity/auth/start", {})).auth;
    expect(started).toMatchObject({ phase: "waiting", kind: "pasted-code" });
    expect(started.authorizationUrl).toContain("https://accounts.google.com/o/oauth2/auth?");
    expect((await call("GET", `/api/instances/antigravity/auth/status?flowId=${started.flowId}`)).auth).toMatchObject({ phase: "waiting" });
    await call("POST", "/api/instances/antigravity/auth/complete", { flowId: started.flowId, callbackUrl: "fixture-code" });

    expect(await status("antigravity")).toMatchObject({ authenticated: true });
    await call("POST", "/api/instances/antigravity/refresh-models", {});
    const listed = (await call("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "antigravity");
    expect(listed.models.options.map((option: any) => option.id)).toContain("fixture-account-model");
    expect(listed.modelsUnconfirmed).toBeUndefined();

    const instance = registry.get("antigravity")!;
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "routes-loop", text: "hello", approvalMode: "ask", cwd: fixture.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000)).toMatchObject({ ok: true });
    recorder.stop();
    expect(fixture.methods()).toContain("session/prompt");

    await call("POST", "/api/instances/antigravity/auth/sign-out", {});
    expect(await status("antigravity")).toMatchObject({ authenticated: false });
    const again = recordEvents(instance.adapter);
    const second = await instance.adapter.sendTurn({ threadId: "routes-loop-2", text: "hello", approvalMode: "ask", cwd: fixture.directory });
    expect(await again.until((event) => event.type === "turn.completed" && event.turnId === second.turnId, 30_000)).toMatchObject({ ok: false, stopReason: "auth_required" });
    again.stop();
    expect(fixture.methods()).not.toContain("authenticate");
  }, 180_000);

  it("asks the CLI again when the person checks, though a signed-out answer was read a moment ago", async () => {
    const { fixture, cfg, registry } = await nativeSetup();
    const { call, status } = await serve(registry, cfg, {
      checkInstance: async (instance) => ({ ok: (await instance.snapshot()).authenticated === true } as never),
    });
    expect(await status("antigravity")).toMatchObject({ authenticated: false });
    // A person signs in at a terminal: no call of ours saw it.
    await loginAt(fixture, antigravityProfileDirectory("antigravity"), "fixture-code");
    expect((await call("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "antigravity").snapshot.authenticated).toBe(false);
    expect(await call("POST", "/api/instances/antigravity/check", {})).toEqual({ ok: true });
  }, 120_000);

  it("starts the CLI once for a signed-in account however often the engine list is read, until a turn is refused", async () => {
    const { fixture, cfg, registry } = await nativeSetup();
    await loginAt(fixture, antigravityProfileDirectory("antigravity"), "fixture-code");
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { call } = await serve(registry, cfg, {
      describeInstances: () => registry.describe({ reuse: { ms: ENGINE_LIST_REUSE_MS, changed: () => {} } }),
    });
    const listed = async (path = "/api/instances") => (await call("GET", path)).instances.find((entry: any) => entry.instanceId === "antigravity").snapshot;
    const instance = registry.get("antigravity")!;
    await instance.refreshModels!();
    const started = () => fixture.methods().filter((method) => method === "initialize").length;
    expect(await listed()).toMatchObject({ authenticated: true });
    const settled = started();

    // An open window reads the list on every focus, at most every 30 s, and setup screens ask for a fresh one.
    for (let step = 1; step <= 40; step += 1) {
      clock += 30_000;
      expect(await listed(step % 5 === 0 ? "/api/instances?fresh=1" : "/api/instances")).toMatchObject({ authenticated: true });
      expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(started()).toBe(settled);

    // The sign-in is removed outside the app: the next turn is refused, and the status says so.
    rmSync(join(antigravityProfileDirectory("antigravity"), "antigravity-acp", "antigravity-oauth-token"));
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "refused", text: "hello", approvalMode: "ask", cwd: fixture.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000)).toMatchObject({ ok: false, stopReason: "auth_required" });
    recorder.stop();
    expect(await listed("/api/instances?fresh=1")).toMatchObject({ authenticated: false });
  }, 180_000);

  it("removes an added account with its profile, and so its own sign-in, without asking the CLI to log out", async () => {
    const { fixture, cfg, registry } = await nativeSetup(["antigravity-added"]);
    const { request, call } = await serve(registry, cfg);
    const flow = (await call("POST", "/api/instances/antigravity-added/auth/start", {})).auth;
    await call("POST", "/api/instances/antigravity-added/auth/complete", { flowId: flow.flowId, callbackUrl: "fixture-code" });

    expect((await request("DELETE", "/api/instances/antigravity-added")).status).toBe(200);
    expect(fixture.methods()).not.toContain("logout");
    expect(existsSync(join(antigravityProfileDirectory("antigravity-added"), "antigravity-acp", "antigravity-oauth-token"))).toBe(false);
    expect(Object.keys(cfg.instances!)).not.toContain("antigravity-added");
  }, 180_000);

  // The CLI keeps one keyring entry per computer unless it runs over SSH (1.5.14) or is told to use files (1.5.16); the
  // app always starts it with both, so every account keeps its own sign-in in its own profile.
  it.each(["1.5.14", "1.5.16"])("keeps each account's sign-in its own on %s: another account is not signed in by it, and a sign-out or removal ends only its own", async (version) => {
    const keyring = folder();
    const { cfg, registry } = await nativeSetup(["antigravity-a", "antigravity-b"], { FAKE_AGY_KEYRING: keyring, FAKE_AGY_KEYRING_SHARED: "1", FAKE_AGY_VERSION: version });
    const { request, call, status } = await serve(registry, cfg);
    for (const id of ["antigravity-a", "antigravity-b"]) {
      const flow = (await call("POST", `/api/instances/${id}/auth/start`, {})).auth;
      await call("POST", `/api/instances/${id}/auth/complete`, { flowId: flow.flowId, callbackUrl: "fixture-code" });
    }
    expect(await status("antigravity")).toMatchObject({ authenticated: false });
    expect(readdirSync(keyring)).toEqual([]);

    expect((await request("DELETE", "/api/instances/antigravity-a")).status).toBe(200);
    await call("POST", "/api/instances/antigravity-b/check", {});
    expect(await status("antigravity-b")).toMatchObject({ authenticated: true });

    const waiting = (await call("POST", "/api/instances/antigravity/auth/start", {})).auth;
    expect((await request("POST", "/api/instances/antigravity-b/auth/sign-out", {})).status).toBe(200);
    expect(await registry.get("antigravity")!.getAuthentication!(waiting.flowId)).toMatchObject({ phase: "waiting" });
    await call("POST", "/api/instances/antigravity-b/check", {});
    expect(await status("antigravity-b")).toMatchObject({ authenticated: false });
  }, 180_000);

  it.each(["1.5.14", "1.5.16"])("never takes up or changes a sign-in the computer's keyring already holds, on %s", async (version) => {
    const keyring = folder();
    writeFileSync(join(keyring, "shared"), "the keyring's own sign-in\n");
    const { cfg, registry } = await nativeSetup([], { FAKE_AGY_KEYRING: keyring, FAKE_AGY_KEYRING_SHARED: "1", FAKE_AGY_VERSION: version });
    const { request, call, status } = await serve(registry, cfg);
    expect(await status("antigravity")).toMatchObject({ authenticated: false });

    const flow = (await call("POST", "/api/instances/antigravity/auth/start", {})).auth;
    await call("POST", "/api/instances/antigravity/auth/complete", { flowId: flow.flowId, callbackUrl: "fixture-code" });
    expect(await status("antigravity")).toMatchObject({ authenticated: true });
    expect((await request("POST", "/api/instances/antigravity/auth/sign-out", {})).status).toBe(200);
    await call("POST", "/api/instances/antigravity/check", {});
    expect(await status("antigravity")).toMatchObject({ authenticated: false });

    expect(readdirSync(keyring)).toEqual(["shared"]);
    expect(readFileSync(join(keyring, "shared"), "utf8")).toBe("the keyring's own sign-in\n");
  }, 180_000);

  it("ends a sign-in that waits for its code, with the CLI's process gone, when the person signs out", async () => {
    const { fixture, cfg, registry } = await nativeSetup();
    const { call } = await serve(registry, cfg);
    const started = (await call("POST", "/api/instances/antigravity/auth/start", {})).auth;
    const pid = fixture.entries().find((entry) => entry.event === "login-start")!.pid as number;
    await call("POST", "/api/instances/antigravity/auth/sign-out", {});
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await registry.get("antigravity")!.getAuthentication!(started.flowId)).toMatchObject({ phase: "cancelled" });
    expect(fixture.entries().some((entry) => entry.event === "login-code")).toBe(false);
  }, 120_000);
});

describe("removing accounts while a ChatGPT account's sign-out waits", () => {
  async function setup() {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ "chatgpt-1": { driver: "fake" }, "chatgpt-2": { driver: "fake" }, "antigravity-1": { driver: "fake" } });
    const gates = new Map<string, { entered: Promise<void>; release: () => void }>();
    for (const id of ["chatgpt-1", "chatgpt-2"]) {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      gates.set(id, { entered, release });
      Object.assign(registry.get(id)!, { signOut: async () => { enter(); await held; } });
    }
    const cfg = { instances: {
      keep: { driver: "fake" },
      "chatgpt-1": { driver: "codex" },
      "chatgpt-2": { driver: "codex" },
      "antigravity-1": { driver: "antigravityAgent" },
    } } as unknown as AppConfig;
    return { registry, cfg, gates };
  }

  it.each([["antigravity-1"], ["chatgpt-2"]])("refuses %s while the first waits, and every removal that succeeded is still there when the config is read again", async (second) => {
    const { registry, cfg, gates } = await setup();
    const { request, persisted } = await serve(registry, cfg);
    const one = request("DELETE", "/api/instances/chatgpt-1");
    try {
      await gates.get("chatgpt-1")!.entered;
      const crossed = await request("DELETE", `/api/instances/${second}`);
      expect(crossed.status).toBe(409);
      expect(crossed.body.error).toContain("already being updated");
      expect((await request("PATCH", "/api/instances/keep", { hidden: true })).status).toBe(409);
      gates.get("chatgpt-1")!.release();
      expect((await one).status).toBe(200);
      const two = request("DELETE", `/api/instances/${second}`);
      const gate = gates.get(second);
      if (gate) { await gate.entered; gate.release(); }
      expect((await two).status).toBe(200);
      expect(Object.keys(cfg.instances!).sort()).toEqual(["keep", ...["chatgpt-2", "antigravity-1"].filter((id) => id !== second)].sort());
      expect(persisted.at(-1) && Object.keys(persisted.at(-1)!)).not.toContain("chatgpt-1");
    } finally {
      for (const gate of gates.values()) gate.release();
      await one.catch(() => {});
    }
  }, 30_000);

  it("reads the config after the lock is taken, so a removal that finished before is not undone", async () => {
    const { registry, cfg, gates } = await setup();
    const { request, setBusy } = await serve(registry, cfg);
    setBusy(true);
    expect((await request("DELETE", "/api/instances/chatgpt-1")).status).toBe(409);
    setBusy(false);
    expect((await request("DELETE", "/api/instances/antigravity-1")).status).toBe(200);
    const next = request("DELETE", "/api/instances/chatgpt-1");
    await gates.get("chatgpt-1")!.entered;
    gates.get("chatgpt-1")!.release();
    expect((await next).status).toBe(200);
    expect(Object.keys(cfg.instances!).sort()).toEqual(["chatgpt-2", "keep"]);
  }, 30_000);
});
