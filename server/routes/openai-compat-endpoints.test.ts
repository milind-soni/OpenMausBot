import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { endpointBaseUrl, endpointDisplayUrl } from "../openai-compat-endpoints.ts";
import { requiredScope } from "../request-auth.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const SECRET = "sk-test-0123456789";

async function serve(options: { hosted?: boolean; botInstance?: string } = {}) {
  const cfg = { instances: { openaiCompat: { driver: "openai-compat" }, claude: { driver: "claudeAgent" } } } as unknown as AppConfig;
  const persisted: InstanceConfigMap[] = [];
  let busy = false;
  const bots = options.botInstance
    ? [{ id: "b1", busy: false, modelSelection: { instanceId: options.botInstance, model: "m" } }]
    : [];
  const deps = {
    store: { bots, tasks: () => [] },
    cfg,
    hostedModels: Boolean(options.hosted),
    providerConfigBusy: { get: () => busy, set: (value: boolean) => { busy = value; } },
    providerInstancesChanging: new Set<string>(),
    describeInstances: async () => Object.entries(cfg.instances ?? {}).map(([instanceId, entry]) => ({
      instanceId, driverKind: entry.driver, displayName: entry.displayName ?? entry.driver,
    })),
    persistProviderInstance: async (_id: string, instances: InstanceConfigMap) => {
      cfg.instances = instances;
      persisted.push(structuredClone(instances));
    },
    threadBusy: () => false,
    botForThread: () => null,
    activeGroupTurnForBot: () => null,
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
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  return { cfg, persisted, call };
}

const add = { displayName: "Zhipu", url: "https://open.bigmodel.cn/api/paas/v4/", key: SECRET, models: ["glm-4.6", "glm-4.6", "glm-5"] };

describe("added OpenAI-compatible servers", () => {
  it("are admin-only", () => {
    expect(requiredScope("POST", "/api/instances/openai-compat")).toBe("admin");
    expect(requiredScope("DELETE", "/api/instances/openai-compat-1")).toBe("admin");
  });

  it("saves a new instance with its own key, base URL and models, and never sends the key back", async () => {
    const { cfg, persisted, call } = await serve();
    const created = await call("POST", "/api/instances/openai-compat", add);
    expect(created.status, created.text).toBe(201);
    const id = created.body.instanceId as string;
    expect(id).toMatch(/^openai-compat-/);
    expect(cfg.instances?.[id]).toEqual({
      driver: "openai-compat", displayName: "Zhipu", access: "api",
      config: { key: SECRET, url: "https://open.bigmodel.cn/api/paas/v4", managedModels: ["glm-4.6", "glm-5"] },
    });
    expect(persisted).toHaveLength(1);
    expect(created.text).not.toContain(SECRET);
    const listed = await call("GET", "/api/instances");
    expect(listed.text).not.toContain(SECRET);
    expect(listed.body.instances.find((row: any) => row.instanceId === id)).toMatchObject({ displayName: "Zhipu", url: "https://open.bigmodel.cn/api/paas/v4" });
    expect(listed.body.instances.find((row: any) => row.instanceId === "openaiCompat")).not.toHaveProperty("url");
  });

  it("refuses base URLs carrying credentials or query strings, and keys that are URLs", async () => {
    const { cfg, call } = await serve();
    for (const url of ["https://user:pass@example.com/v1", "https://example.com/v1?api-key=secret", "ftp://example.com/v1", "example.com/v1"]) {
      const response = await call("POST", "/api/instances/openai-compat", { ...add, url });
      expect(response.status, url).toBe(400);
      expect(response.text).not.toContain("secret");
    }
    expect((await call("POST", "/api/instances/openai-compat", { ...add, key: "https://example.com/v1" })).status).toBe(400);
    expect((await call("POST", "/api/instances/openai-compat", { ...add, displayName: "" })).status).toBe(400);
    expect(Object.keys(cfg.instances ?? {})).toEqual(["openaiCompat", "claude"]);
  });

  it("removes an unused added server but never the built-in slot or one a bot uses", async () => {
    const { cfg, call } = await serve();
    const id = (await call("POST", "/api/instances/openai-compat", add)).body.instanceId as string;
    expect((await call("DELETE", "/api/instances/openaiCompat")).status).toBe(400);
    const removed = await call("DELETE", `/api/instances/${id}`);
    expect(removed.status, removed.text).toBe(200);
    expect(cfg.instances).not.toHaveProperty(id);

    const used = await serve({ botInstance: "openai-compat-used" });
    used.cfg.instances = { ...used.cfg.instances, "openai-compat-used": { driver: "openai-compat", displayName: "Used", config: { key: SECRET, url: "https://example.com/v1" } } };
    expect((await used.call("DELETE", "/api/instances/openai-compat-used")).status).toBe(409);
    expect(used.cfg.instances).toHaveProperty("openai-compat-used");
  });

  it("is read-only on a hosted server", async () => {
    const { cfg, call } = await serve({ hosted: true });
    expect((await call("POST", "/api/instances/openai-compat", add)).status).toBe(403);
    expect(Object.keys(cfg.instances ?? {})).toEqual(["openaiCompat", "claude"]);
  });
});

describe("base URL handling", () => {
  it("keeps origin and path only", () => {
    expect(endpointBaseUrl(" http://localhost:11434/v1/ ")).toBe("http://localhost:11434/v1");
    expect(endpointBaseUrl("https://a.example/v1#x")).toBeNull();
    expect(endpointDisplayUrl({ url: "https://user:pw@a.example/v1?key=s#f" })).toBe("https://a.example/v1");
    expect(endpointDisplayUrl({ url: "not a url" })).toBeUndefined();
    expect(endpointDisplayUrl({})).toBeUndefined();
  });
});
