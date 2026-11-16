import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { endpointBaseUrl, endpointDisplayUrl, endpointModelsReadable } from "../openai-compat-endpoints.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const SECRET = "sk-test-0123456789";

async function serve(options: {
  hosted?: boolean; botInstance?: string; botBusy?: boolean; auth?: RequestAuth;
  readable?: (config: { url: string; key: string }) => Promise<boolean>;
} = {}) {
  const cfg = { instances: { openaiCompat: { driver: "openai-compat" }, claude: { driver: "claudeAgent" } } } as unknown as AppConfig;
  const persisted: InstanceConfigMap[] = [];
  const refreshed: string[] = [];
  let busy = false;
  const bots = options.botInstance
    ? [{ id: "b1", busy: Boolean(options.botBusy), modelSelection: { instanceId: options.botInstance, model: "m" } }]
    : [];
  const deps = {
    store: { bots, tasks: () => [] },
    cfg,
    registry: { refreshModels: async (instanceId: string) => { refreshed.push(instanceId); return true; } },
    endpointModelsReadable: options.readable ?? (async () => true),
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
      auth: options.auth ?? { kind: "loopback", scopes: ["admin"] }, json, readBody,
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
  return { cfg, persisted, refreshed, call, busy: () => busy };
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

  it("refuses a second local server at an address already added, even when the first add just finished", async () => {
    const { cfg, call } = await serve();
    const local = { displayName: "LM Studio", url: "http://127.0.0.1:1234/v1", key: "lm-studio", catalog: "lmstudio" };
    const [first, second] = await Promise.all([call("POST", "/api/instances/openai-compat", local), call("POST", "/api/instances/openai-compat", local)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const again = await call("POST", "/api/instances/openai-compat", { ...local, url: "http://127.0.0.1:1234/v1/" });
    expect(again.status, again.text).toBe(409);
    expect(again.body.error).toMatch(/already an engine/);
    expect(Object.keys(cfg.instances ?? {}).filter((id) => id.startsWith("openai-compat-"))).toHaveLength(1);
  });

  it("is read-only on a hosted server", async () => {
    const { cfg, call } = await serve({ hosted: true });
    expect((await call("POST", "/api/instances/openai-compat", add)).status).toBe(403);
    expect(Object.keys(cfg.instances ?? {})).toEqual(["openaiCompat", "claude"]);
  });
});

describe("changing an added server's base URL", () => {
  const ID = "openai-compat-edit";
  const seed = (cfg: AppConfig, config: Record<string, unknown> = { key: SECRET, url: "https://old.example.com/v1", managedModels: ["glm-5"] }) => {
    cfg.instances = { ...cfg.instances, [ID]: { driver: "openai-compat", displayName: "Zhipu", access: "api", config } };
  };

  it("is admin-only", () => {
    expect(requiredScope("PATCH", `/api/instances/${ID}`)).toBe("admin");
  });

  it("changes the address in place, keeping the id, models, the bot using it and the saved key", async () => {
    const { cfg, refreshed, call } = await serve({ botInstance: ID });
    seed(cfg);
    const changed = await call("PATCH", `/api/instances/${ID}`, { url: " https://old.example.com/api/v2/ " });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.text).not.toContain(SECRET);
    expect(cfg.instances?.[ID]).toEqual({
      driver: "openai-compat", displayName: "Zhipu", access: "api",
      config: { key: SECRET, url: "https://old.example.com/api/v2", managedModels: ["glm-5"] },
    });
    // Models were entered by hand, so nothing is detected again.
    expect(refreshed).toEqual([]);
  });

  it("detects the models again when they came from the server's own list", async () => {
    const { cfg, refreshed, call } = await serve();
    seed(cfg, { key: SECRET, url: "https://old.example.com/v1" });
    expect((await call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" })).status).toBe(200);
    expect(refreshed).toEqual([ID]);
  });

  it("refuses a bad address and changes nothing", async () => {
    const { cfg, persisted, call } = await serve();
    seed(cfg);
    for (const url of ["ftp://old.example.com/v1", "old.example.com/v1", "https://u:p@old.example.com/v1", "https://old.example.com/v1?key=x", ""]) {
      expect((await call("PATCH", `/api/instances/${ID}`, { url })).status, url).toBe(400);
    }
    expect((await call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2", apiKey: "https://x.example" })).status).toBe(400);
    expect(persisted).toEqual([]);
    expect((cfg.instances?.[ID]?.config as { url?: string } | undefined)?.url).toBe("https://old.example.com/v1");
  });

  it("needs the key again when the host changes, and takes a new key with the address", async () => {
    const { cfg, call } = await serve();
    seed(cfg);
    for (const url of ["https://new.example.com/v1", "https://old.example.com:8443/v1"]) {
      const refused = await call("PATCH", `/api/instances/${ID}`, { url });
      expect(refused.status, url).toBe(400);
      expect(refused.body.error).toMatch(/API key again/);
    }
    expect((cfg.instances?.[ID]?.config as { url?: string } | undefined)?.url).toBe("https://old.example.com/v1");
    const moved = await call("PATCH", `/api/instances/${ID}`, { url: "https://new.example.com/v1", apiKey: "sk-new" });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.text).not.toContain("sk-new");
    expect(cfg.instances?.[ID]?.config).toEqual({ key: "sk-new", url: "https://new.example.com/v1", managedModels: ["glm-5"] });
    const rekeyed = await call("PATCH", `/api/instances/${ID}`, { apiKey: "sk-third" });
    expect(rekeyed.status, rekeyed.text).toBe(200);
    expect(cfg.instances?.[ID]?.config).toMatchObject({ key: "sk-third", url: "https://new.example.com/v1" });
  });

  it("needs the key again when https becomes http on the same host", async () => {
    const { cfg, call } = await serve();
    seed(cfg);
    const refused = await call("PATCH", `/api/instances/${ID}`, { url: "http://old.example.com/v1" });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error).toMatch(/API key again/);
    expect(cfg.instances?.[ID]?.config).toMatchObject({ key: SECRET, url: "https://old.example.com/v1" });
  });

  it("moves an Ollama server's placeholder key to another host without asking", async () => {
    const { cfg, call } = await serve();
    seed(cfg, { key: "ollama", url: "http://127.0.0.1:11434", catalog: "ollama" });
    const listed = await call("GET", "/api/instances");
    expect(listed.body.instances.find((row: any) => row.instanceId === ID)).toMatchObject({ placeholderKey: true });
    const moved = await call("PATCH", `/api/instances/${ID}`, { url: "http://192.168.1.20:11434" });
    expect(moved.status, moved.text).toBe(200);
    expect(cfg.instances?.[ID]?.config).toEqual({ key: "ollama", url: "http://192.168.1.20:11434", catalog: "ollama" });
  });

  it("saves an address whose model list can't be read, says so, and reads it after the busy guard", async () => {
    let busyWhileReading: boolean | undefined;
    const asked: Array<{ url: string; key: string }> = [];
    const server = await serve({ readable: async (config) => { asked.push(config); busyWhileReading = server.busy(); return false; } });
    seed(server.cfg, { key: SECRET, url: "https://old.example.com/v1" });
    const saved = await server.call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.warning).toMatch(/model list could not be read/);
    expect(saved.text).not.toContain(SECRET);
    expect(asked).toEqual([{ url: "https://old.example.com/v2", key: SECRET }]);
    expect(busyWhileReading).toBe(false);
    expect((server.cfg.instances?.[ID]?.config as { url?: string } | undefined)?.url).toBe("https://old.example.com/v2");

    const fine = await serve();
    seed(fine.cfg, { key: SECRET, url: "https://old.example.com/v1" });
    const clean = await fine.call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" });
    expect(clean.status).toBe(200);
    expect(clean.body).not.toHaveProperty("warning");
  });

  it("waits while a bot using it is mid-turn, or while provider settings are changing", async () => {
    const { cfg, persisted, call } = await serve({ botInstance: ID, botBusy: true });
    seed(cfg);
    expect((await call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" })).status).toBe(409);
    expect(persisted).toEqual([]);
  });

  it("is refused for the built-in slot, other engines, a client without admin and a hosted server", async () => {
    const { cfg, call } = await serve();
    seed(cfg);
    expect((await call("PATCH", "/api/instances/openaiCompat", { url: "https://x.example/v1", apiKey: "k" })).status).toBe(400);
    expect((await call("PATCH", "/api/instances/claude", { url: "https://x.example/v1", apiKey: "k" })).status).toBe(400);
    const service = await serve({ auth: { kind: "loopback", scopes: ["client"], trust: "service" } });
    seed(service.cfg);
    expect((await service.call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" })).status).toBe(403);
    const hosted = await serve({ hosted: true });
    seed(hosted.cfg);
    expect((await hosted.call("PATCH", `/api/instances/${ID}`, { url: "https://old.example.com/v2" })).status).toBe(403);
  });
});

describe("reading an added server's model list", () => {
  it("is true only when /models answers a list with the key", async () => {
    const server = createServer((req, res) => {
      const ok = req.url === "/v1/models" && req.headers.authorization === `Bearer ${SECRET}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { data: [{ id: "m" }] } : { error: "no" }));
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    expect(await endpointModelsReadable({ url, key: SECRET })).toBe(true);
    expect(await endpointModelsReadable({ url, key: "wrong" })).toBe(false);
    expect(await endpointModelsReadable({ url: `${url}/nope`, key: SECRET })).toBe(false);
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
