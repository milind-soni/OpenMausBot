// A finished sign-in step changes what an engine reports: the next engine list probes its CLI again.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { json, readBody } from "../harness/http.ts";
import { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(extra: Partial<InstanceRouteDeps> = {}) {
  const fake = makeFakeDriver();
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ a: { driver: "fake" } });
  const sign = {
    start: { phase: "waiting", flowId: "flow-1", authorizationUrl: "https://example.test/sign-in", expiresAt: null } as ProviderAuthenticationStart,
    status: { phase: "waiting", flowId: "flow-1", authorizationUrl: null, expiresAt: null } as ProviderAuthenticationStatus,
  };
  Object.assign(registry.get("a")!, {
    startAuthentication: async () => ({ ...sign.start }),
    getAuthentication: async () => ({ ...sign.status }),
    completeAuthentication: async () => {},
    cancelAuthentication: async () => {},
    signOut: async () => {},
  });
  const deps = {
    store: { bots: [], tasks: () => [] },
    cfg: { instances: { a: { driver: "fake" } } } as unknown as AppConfig,
    registry,
    sessions: { isLive: () => true },
    providerAuthSessions: new ProviderAuthSessions(),
    hostedModels: false,
    providerConfigBusy: { get: () => false, set: () => {} },
    providerInstancesChanging: new Set<string>(),
    describeInstances: () => registry.describe(),
    threadBusy: () => false,
    botForThread: () => null,
    activeGroupTurnForBot: () => null,
    ...extra,
  } as unknown as InstanceRouteDeps;
  const routes = [createInstanceRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<any>;
  };
  const probesAfterList = async () => {
    await call("GET", "/api/instances");
    return fake.probes.length;
  };
  return { sign, call, probesAfterList, base };
}

describe("engine sign-in routes", () => {
  it("probe the engine again after a sign-in that finished at once, a device sign-in, a pasted code or a sign-out", async () => {
    const { sign, call, probesAfterList } = await serve();
    expect(await probesAfterList()).toBe(1);
    expect(await probesAfterList()).toBe(1);

    // Still waiting: nothing changed yet.
    expect((await call("POST", "/api/instances/a/auth/start", {})).auth).toMatchObject({ phase: "waiting" });
    expect((await call("GET", "/api/instances/a/auth/status?flowId=flow-1")).auth).toMatchObject({ phase: "waiting" });
    expect(await probesAfterList()).toBe(1);

    sign.status.phase = "succeeded";
    expect((await call("GET", "/api/instances/a/auth/status?flowId=flow-1")).auth).toMatchObject({ phase: "succeeded" });
    expect(await probesAfterList()).toBe(2);

    sign.start.flowId = "flow-2";
    await call("POST", "/api/instances/a/auth/start", {});
    expect(await probesAfterList()).toBe(2);
    await call("POST", "/api/instances/a/auth/complete", { flowId: "flow-2", code: "pasted-code" });
    expect(await probesAfterList()).toBe(3);

    sign.start.phase = "succeeded";
    expect((await call("POST", "/api/instances/a/auth/start", {})).auth).toMatchObject({ phase: "succeeded" });
    expect(await probesAfterList()).toBe(4);

    await call("POST", "/api/instances/a/auth/sign-out", {});
    expect(await probesAfterList()).toBe(5);
  });
});

describe("an engine's check", () => {
  it("goes through the server's tested-AI record, so the welcome's test also settles the new-bot default", async () => {
    const asked: string[] = [];
    const { call } = await serve({ checkInstance: async (instance) => { asked.push(instance.instanceId); return { ok: false, error: "no answer" }; } });
    expect(await call("POST", "/api/instances/a/check", {})).toEqual({ ok: false, error: "no answer" });
    expect(asked).toEqual(["a"]);
  });
});

describe("installing an engine's own build from Settings", () => {
  async function serveInstall(options: { useCli?: string; busy?: boolean }) {
    const persisted: Array<{ instanceId: string; instances: unknown }> = [];
    const deps = {
      store: { bots: [], tasks: () => [] },
      cfg: { instances: { opencode: { driver: "opencodeGo" } } } as unknown as AppConfig,
      registry: {
        installRuntime: async () => options.useCli ? { useCli: options.useCli } : true,
        get: () => null,
        forgetSnapshots: () => {},
        refreshModels: async () => true,
        cliTarget: () => null,
      },
      sessions: { isLive: () => true },
      providerAuthSessions: new ProviderAuthSessions(),
      hostedModels: false,
      providerConfigBusy: { get: () => options.busy === true, set: () => {} },
      providerInstancesChanging: new Set<string>(),
      describeInstances: async () => [],
      persistProviderInstance: async (instanceId: string, instances: unknown) => { persisted.push({ instanceId, instances }); },
      threadBusy: () => false,
      botForThread: () => null,
      activeGroupTurnForBot: () => null,
    } as unknown as InstanceRouteDeps;
    const routes = [createInstanceRoutes(deps)];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/instances/opencode/install`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    return { status: response.status, body: await response.json() as Record<string, unknown>, persisted };
  }

  it("points the engine at the app's own copy, as Set CLI would, and says so", async () => {
    const appCopy = "/data/tools/standalone/opencode/bin/opencode";
    const { status, body, persisted } = await serveInstall({ useCli: appCopy });
    expect(status).toBe(200);
    expect(body.usingAppCopy).toBe(true);
    expect(persisted).toEqual([{ instanceId: "opencode", instances: { opencode: { driver: "opencodeGo", config: { cli: appCopy } } } }]);
  });

  it("changes nothing while provider settings are being saved", async () => {
    const { body, persisted } = await serveInstall({ useCli: "/data/tools/standalone/opencode/bin/opencode", busy: true });
    expect(body.usingAppCopy).toBeUndefined();
    expect(persisted).toEqual([]);
  });

  it("changes nothing when the CLI already starts", async () => {
    const { body, persisted } = await serveInstall({});
    expect(body.usingAppCopy).toBeUndefined();
    expect(persisted).toEqual([]);
  });
});

describe("a server's reply wait", () => {
  it("saves minutes for an OpenAI-compatible server, clears them with null, and refuses other engines or bad values", async () => {
    const persisted: Array<Record<string, { driver: string; config?: Record<string, unknown> }>> = [];
    const cfg = { instances: { a: { driver: "fake" }, "openai-compat-1": { driver: "openai-compat", config: { url: "http://127.0.0.1:11434/v1", key: "k" } } } };
    const { call, base } = await serve({
      cfg: cfg as unknown as AppConfig,
      persistProviderInstance: async (_id: string, instances: typeof persisted[number]) => {
        persisted.push(structuredClone(instances));
        (cfg as { instances: unknown }).instances = instances;
      },
    });
    await call("PATCH", "/api/instances/openai-compat-1", { replyWaitMinutes: 20 });
    expect(persisted.at(-1)!["openai-compat-1"]!.config).toEqual({ url: "http://127.0.0.1:11434/v1", key: "k", replyWaitMinutes: 20 });
    await call("PATCH", "/api/instances/openai-compat-1", { replyWaitMinutes: null });
    expect(persisted.at(-1)!["openai-compat-1"]!.config).toEqual({ url: "http://127.0.0.1:11434/v1", key: "k" });
    const status = async (id: string, body: unknown) => (await fetch(`${base}/api/instances/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status;
    expect(await status("a", { replyWaitMinutes: 20 })).toBe(400);
    for (const bad of [0, 61, 2.5, "10"]) expect(await status("openai-compat-1", { replyWaitMinutes: bad })).toBe(400);
    expect(persisted).toHaveLength(2);
  });
});

