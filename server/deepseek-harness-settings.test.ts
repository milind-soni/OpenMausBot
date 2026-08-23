import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeepSeekHarnessManagementClient,
  DeepSeekHarnessSettingsError,
  acceptDeepSeekHarnessPairing,
  normalizeDeepSeekHarnessBaseUrl,
  parseDeepSeekHarnessConnectionPatch,
  parseDeepSeekHarnessDiscoverRequest,
  parseDeepSeekHarnessPairRequest,
  parseDeepSeekHarnessUpsertRequest,
  type DeepSeekHarnessModelProfile,
} from "./deepseek-harness-settings.ts";
import { dshClientRequestSchema, dshJsonValueSchema, type DshJsonValue } from "./drivers/deepseek-harness/protocol.ts";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: DshJsonValue | undefined;
}

interface FakeOptions {
  mutateConflict?: boolean;
  pairedActionForbidden?: boolean;
  pairedAuthorized?: boolean;
  pluginAvailable?: boolean;
  pluginDelayMs?: number;
  pluginOversized?: boolean;
  pairStatus?: number;
  pairRedirect?: string;
  pluginRedirect?: string;
  setCookies?: string[];
}

class FakeManagementHost {
  private server: Server | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly options: FakeOptions;
  revision = 7;
  profile = dshJsonValueSchema.parse({
    models: [
      { id: "keep", name: "Keep", input: ["text"], compat: { preserve: true } },
      { id: "change", name: "Old", custom: "kept" },
    ],
    apiKey: "must-never-leave-dsh",
  });
  catalog = {
    groups: [{ id: "openrouter", name: "OpenRouter", models: [{ id: "installed", name: "Installed" }] }],
    failures: [],
  };

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  get baseUrl(): string {
    const address = z.object({ port: z.number().int().positive().max(65_535) }).safeParse(this.server?.address());
    if (!address.success) throw new Error("fake host is not listening");
    return `http://127.0.0.1:${address.data.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await readText(req);
    let body: DshJsonValue | undefined;
    try {
      body = text ? dshJsonValueSchema.parse(JSON.parse(text)) : undefined;
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });

    if (path === "/api/pair/accept") {
      if (this.options.pairRedirect) {
        res.writeHead(302, { location: this.options.pairRedirect });
        res.end();
        return;
      }
      const status = this.options.pairStatus ?? 200;
      res.setHeader("content-type", "application/json");
      if (status === 200) res.setHeader("set-cookie", this.options.setCookies ?? ["dsh_pair=device-1; Path=/; HttpOnly; SameSite=Lax"]);
      res.writeHead(status);
      res.end(JSON.stringify(status === 200 ? { ok: true, deviceId: "device-1" } : { ok: false, code: "unknown" }));
      return;
    }

    if (path.startsWith("/api/pair/model-catalog")) {
      if (this.options.pluginRedirect) {
        res.writeHead(302, { location: this.options.pluginRedirect });
        res.end();
        return;
      }
      if (this.options.pluginAvailable === false) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing plugin route");
        return;
      }
      if (req.headers.cookie !== "dsh_pair=device-1" || this.options.pairedAuthorized === false) {
        return sendJson(res, 403, { error: "unpaired-secret-detail" });
      }
      if (this.options.pairedActionForbidden && path !== "/api/pair/model-catalog") {
        return sendJson(res, 403, { error: "stale-provider-secret-detail" });
      }
      if (this.options.pluginDelayMs !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        setTimeout(() => sendJsonBody(res, {
          capability: "paired-model-catalog",
          providers: [{ provider: "openrouter", displayName: "OpenRouter" }],
        }), this.options.pluginDelayMs).unref?.();
        return;
      }
      if (this.options.pluginOversized) return sendJson(res, 200, { padding: "x".repeat(300 * 1024) });
      if (path !== "/api/pair/model-catalog" && z.object({ provider: z.string() }).safeParse(body).data?.provider === "missing") {
        return sendJson(res, 404, { error: "unknown provider" });
      }
      if (path.endsWith("/discover")) return sendJson(res, 200, { models: [{ id: "new/model", name: "New model", contextWindow: 64_000, maxTokens: 8_000 }] });
      if (path.endsWith("/upsert")) return sendJson(res, 200, this.catalog);
      return sendJson(res, 200, { capability: "paired-model-catalog", providers: [{ provider: "openrouter", displayName: "OpenRouter" }] });
    }

    if (!path.startsWith("/api/")) return sendJson(res, 404, { error: "missing" });
    const envelope = dshClientRequestSchema.parse(body);
    if (envelope.method === "settings.mutate" && this.options.mutateConflict) {
      return sendJson(res, 200, {
        type: "server-response",
        rpcId: envelope.rpcId,
        result: {
          ok: false,
          error: {
            code: "settings-conflict",
            message: "upstream-secret-detail",
            details: { ns: "llm-pi-ai", expected: 7, actual: 8 },
          },
        },
      });
    }
    const value = this.directValue(envelope.method, envelope.payload);
    sendJson(res, 200, { type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value } });
  }

  private directValue(method: string, payload: DshJsonValue): DshJsonValue {
    if (method === "host.describe") return { version: "fixture", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false };
    if (method === "llm.providers") return { providers: [
      { provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"], active: true },
      { provider: "inactive", displayName: "Inactive", settingsNs: "llm-pi-ai", settingsPath: ["providers", "inactive"], active: false },
      { provider: "wrong", displayName: "Wrong", settingsNs: "llm-other", settingsPath: ["providers", "wrong"], active: true },
    ] };
    if (method === "settings.describe") return {
      writable: true,
      hasDocument: true,
      namespaces: [{ ns: "llm-pi-ai", schema: {}, value: { providers: { openrouter: this.profile } }, applies: "live", secrets: [{ path: ["providers", "openrouter", "apiKey"], set: true }], revision: this.revision }],
    };
    if (method === "llm.discoverModels") return { models: [{ id: "new/model", name: "New model", contextWindow: 64_000, maxTokens: 8_000 }] };
    if (method === "llm.models") return this.catalog;
    if (method === "settings.mutate") {
      this.revision += 1;
      return { ns: "llm-pi-ai", schema: {}, value: {}, applies: "live", secrets: [], revision: this.revision };
    }
    throw new Error(`unsupported fixture method ${method}: ${JSON.stringify(payload)}`);
  }
}

const servers: FakeManagementHost[] = [];

async function host(options: FakeOptions = {}): Promise<FakeManagementHost> {
  const fake = new FakeManagementHost(options);
  await fake.start();
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("DeepSeek Harness settings validation", () => {
  it("normalizes explicit HTTP and HTTPS origins without assuming localhost", () => {
    expect(normalizeDeepSeekHarnessBaseUrl(" https://backsight-homelab.example.ts.net:10443/ ")).toBe("https://backsight-homelab.example.ts.net:10443");
    expect(normalizeDeepSeekHarnessBaseUrl("http://100.64.0.8:3080")).toBe("http://100.64.0.8:3080");
  });

  it.each([
    "ftp://dsh.example.test",
    "https://user:password@dsh.example.test",
    "https://dsh.example.test/remote",
    "https://dsh.example.test?secret=value",
    "not-a-url",
  ])("rejects an unsafe base URL: %s", (value) => {
    expect(() => normalizeDeepSeekHarnessBaseUrl(value)).toThrow(DeepSeekHarnessSettingsError);
  });

  it("accepts bounded strict route bodies and canonical effort order", () => {
    expect(parseDeepSeekHarnessConnectionPatch({ baseUrl: "https://dsh.example.test/", transport: "direct", agentPreset: " coder " })).toEqual({
      baseUrl: "https://dsh.example.test",
      transport: "direct",
      agentPreset: "coder",
    });
    expect(parseDeepSeekHarnessPairRequest({ pairingLink: "https://dsh.example.test/m/?pair=one-time" })).toEqual({ pairingLink: "https://dsh.example.test/m/?pair=one-time" });
    expect(parseDeepSeekHarnessDiscoverRequest({ provider: " openrouter " })).toEqual({ provider: "openrouter" });
    expect(parseDeepSeekHarnessUpsertRequest({ provider: "openrouter", model: { id: "deepseek/deepseek-v3", reasoningEfforts: ["off", "low", "high"] } })).toEqual({
      provider: "openrouter",
      model: { id: "deepseek/deepseek-v3", reasoningEfforts: ["off", "low", "high"] },
    });
  });

  it("rejects malformed, oversized, unknown, and non-canonical inputs", () => {
    const invalid = [
      () => parseDeepSeekHarnessConnectionPatch(JSON.parse('{"transport":"paired","unknown":true}')),
      () => parseDeepSeekHarnessConnectionPatch({ agentPreset: "x".repeat(513) }),
      () => parseDeepSeekHarnessPairRequest({ pairingLink: `https://dsh.example.test/m/?pair=${"x".repeat(513)}` }),
      () => parseDeepSeekHarnessDiscoverRequest({ provider: "x".repeat(161) }),
      () => parseDeepSeekHarnessUpsertRequest({ provider: "openrouter", model: { id: "bad\nmodel" } }),
      () => parseDeepSeekHarnessUpsertRequest({ provider: "openrouter", model: { id: "model", contextWindow: 1.5 } }),
      () => parseDeepSeekHarnessUpsertRequest({ provider: "openrouter", model: { id: "model", maxTokens: 10_000_001 } }),
      () => parseDeepSeekHarnessUpsertRequest({ provider: "openrouter", model: { id: "model", reasoningEfforts: ["high", "low"] } }),
    ];
    for (const parse of invalid) expect(parse).toThrow(DeepSeekHarnessSettingsError);
  });
});

describe("DeepSeek Harness pairing", () => {
  it("consumes one token at the link origin and keeps only the cookie pair", async () => {
    const fake = await host({ setCookies: ["dsh_pair=device-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=123"] });
    const result = await acceptDeepSeekHarnessPairing(`${fake.baseUrl}/m/?pair=one-time&workspace=ws-1`);
    expect(result).toEqual({ baseUrl: fake.baseUrl, deviceCookie: "dsh_pair=device-1" });
    expect(fake.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/api/pair/accept",
      body: { token: "one-time" },
    }));
    expect(JSON.stringify(result)).not.toContain("one-time");
  });

  it("rejects a failed accept without returning a cookie", async () => {
    const fake = await host({ pairStatus: 404 });
    await expect(acceptDeepSeekHarnessPairing(`${fake.baseUrl}/m/?pair=bad-token`)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects missing, ambiguous, or unsafe device cookies", async () => {
    for (const setCookies of [[], ["a=1; Path=/; HttpOnly", "b=2; Path=/; HttpOnly"], ["dsh_pair=bad value; Path=/; HttpOnly"]]) {
      const fake = await host({ setCookies });
      await expect(acceptDeepSeekHarnessPairing(`${fake.baseUrl}/m/?pair=one-time`)).rejects.toThrow("device cookie");
    }
  });

  it("does not follow a pairing redirect or forward the one-time token", async () => {
    const target = await host();
    const source = await host({ pairRedirect: `${target.baseUrl}/capture` });
    await expect(acceptDeepSeekHarnessPairing(`${source.baseUrl}/m/?pair=redirect-secret`)).rejects.toMatchObject({ status: 502 });
    expect(target.requests).toEqual([]);
  });
});

describe("DeepSeek Harness model management", () => {
  it("probes direct capability and exposes only eligible provider identities", async () => {
    const fake = await host();
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    const result = await client.describe();
    expect(result).toEqual({ available: true, supported: true, providers: [{ provider: "openrouter", displayName: "OpenRouter" }] });
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/host.describe",
      "/api/llm.providers",
      "/api/settings.describe",
    ]);
    expect(JSON.stringify(result)).not.toContain("must-never-leave-dsh");
  });

  it("discovers direct models through the exact stored pi-ai provider route", async () => {
    const fake = await host();
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    await expect(client.discover({ provider: "openrouter" })).resolves.toEqual({
      models: [{ id: "new/model", name: "New model", contextWindow: 64_000, maxTokens: 8_000 }],
    });
    const discovery = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/llm.discoverModels")?.body);
    expect(discovery.payload).toEqual({ settingsNs: "llm-pi-ai", provider: "openrouter" });
  });

  it("revision-safely updates only the exact model list and preserves existing entries and fields", async () => {
    const fake = await host();
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    const model: DeepSeekHarnessModelProfile = {
      id: "change",
      name: "New",
      contextWindow: 32_000,
      reasoningEfforts: ["off", "low", "high"],
    };
    const result = await client.upsert({ provider: "openrouter", model });
    expect(result.updated).toBe(true);
    const mutation = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/settings.mutate")?.body);
    expect(mutation.payload).toEqual({
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [{
        op: "set",
        path: ["providers", "openrouter", "models"],
        value: [
          { id: "keep", name: "Keep", input: ["text"], compat: { preserve: true } },
          { id: "change", name: "New", custom: "kept", contextWindow: 32_000, reasoningEfforts: { off: null, low: "low", high: "high" } },
        ],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("must-never-leave-dsh");
  });

  it("updates an installed model through modelOverrides when the resolved model list is empty", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({
      models: [],
      modelOverrides: { installed: { maxTokens: 2_048, custom: "preserved" } },
      apiKey: "must-never-leave-dsh",
    });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await client.upsert({ provider: "openrouter", model: { id: "installed", maxTokens: 4_096 } });

    const mutation = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/settings.mutate")?.body);
    expect(mutation.payload).toEqual({
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [{
        op: "set",
        path: ["providers", "openrouter", "modelOverrides", "installed"],
        value: { maxTokens: 4_096, custom: "preserved" },
      }],
    });
  });

  it("adopts an installed model from the real empty resolved profile without materializing the catalog", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({ models: [], modelOverrides: {} });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await client.upsert({ provider: "openrouter", model: { id: "installed", maxTokens: 4_096 } });

    const mutation = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/settings.mutate")?.body);
    expect(mutation.payload).toEqual({
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [{
        op: "set",
        path: ["providers", "openrouter", "modelOverrides", "installed"],
        value: { maxTokens: 4_096 },
      }],
    });
  });

  it("removes an empty modelOverrides object when updating an explicit model list", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({
      models: [{ id: "change", name: "Old", custom: "preserved" }],
      modelOverrides: {},
    });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await client.upsert({ provider: "openrouter", model: { id: "change", name: "New" } });

    const mutation = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/settings.mutate")?.body);
    expect(mutation.payload).toEqual({
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [
        {
          op: "set",
          path: ["providers", "openrouter", "models"],
          value: [{ id: "change", name: "New", custom: "preserved" }],
        },
        { op: "unset", path: ["providers", "openrouter", "modelOverrides"] },
      ],
    });
  });

  it("materializes every installed model and translates overrides before adding an unknown inherited model", async () => {
    const fake = await host();
    fake.catalog = {
      groups: [{
        id: "openrouter",
        name: "OpenRouter",
        models: [
          { id: "installed-a", name: "Installed A" },
          { id: "installed-b", name: "Installed B" },
        ],
      }],
      failures: [],
    };
    fake.profile = dshJsonValueSchema.parse({
      models: [],
      modelOverrides: { "installed-a": { maxTokens: 2_048, custom: "preserved" } },
      apiKey: "must-never-leave-dsh",
    });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await client.upsert({ provider: "openrouter", model: { id: "new/model", name: "New model", contextWindow: 32_000 } });

    const mutation = dshClientRequestSchema.parse(fake.requests.find((request) => request.path === "/api/settings.mutate")?.body);
    expect(mutation.payload).toEqual({
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [
        {
          op: "set",
          path: ["providers", "openrouter", "models"],
          value: [
            { id: "installed-a", maxTokens: 2_048, custom: "preserved" },
            { id: "installed-b" },
            { id: "new/model", name: "New model", contextWindow: 32_000 },
          ],
        },
        { op: "unset", path: ["providers", "openrouter", "modelOverrides"] },
      ],
    });
  });

  it("maps a direct revision conflict without exposing the upstream envelope", async () => {
    const fake = await host({ mutateConflict: true });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    const failure = await client.upsert({ provider: "openrouter", model: { id: "new/model" } }).catch((error) => error);
    expect(failure).toMatchObject({ status: 409, code: "model-update-conflict" });
    expect(String(failure)).not.toContain("upstream-secret-detail");
  });

  it("refuses to reconstruct a present but malformed configured model list", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({ models: "corrupt", apiKey: "must-never-leave-dsh" });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    await expect(client.upsert({ provider: "openrouter", model: { id: "new/model" } })).rejects.toMatchObject({ status: 502 });
    expect(fake.requests.some((request) => request.path === "/api/settings.mutate")).toBe(false);
  });

  it("refuses a malformed entry inside an explicit configured model list", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({ models: [42, { id: "valid" }], modelOverrides: {} });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    await expect(client.upsert({ provider: "openrouter", model: { id: "new/model" } })).rejects.toMatchObject({ status: 502 });
    expect(fake.requests.some((request) => request.path === "/api/settings.mutate")).toBe(false);
  });

  it("refuses conflicting explicit models and non-empty modelOverrides", async () => {
    const fake = await host();
    fake.profile = dshJsonValueSchema.parse({
      models: [{ id: "valid", custom: "preserved" }],
      modelOverrides: { valid: { maxTokens: 2_048 } },
    });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "direct" });
    await expect(client.upsert({ provider: "openrouter", model: { id: "valid", maxTokens: 4_096 } })).rejects.toMatchObject({
      status: 502,
      code: "conflicting-model-configuration",
    });
    expect(fake.requests.some((request) => request.path === "/api/settings.mutate")).toBe(false);
  });

  it("uses the exact paired plugin paths and cookie without generic settings access", async () => {
    const fake = await host();
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    await expect(client.describe()).resolves.toEqual({ available: true, supported: true, providers: [{ provider: "openrouter", displayName: "OpenRouter" }] });
    await expect(client.discover({ provider: "openrouter" })).resolves.toEqual({ models: [{ id: "new/model", name: "New model", contextWindow: 64_000, maxTokens: 8_000 }] });
    await expect(client.upsert({ provider: "openrouter", model: { id: "new/model" } })).resolves.toMatchObject({ updated: true });
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/pair/model-catalog",
      "/api/pair/model-catalog/discover",
      "/api/pair/model-catalog/upsert",
    ]);
    for (const request of fake.requests) expect(request.headers.cookie).toBe("dsh_pair=device-1");
  });

  it("reports the older paired plugin as an explicit non-fatal capability fallback", async () => {
    const fake = await host({ pluginAvailable: false });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    await expect(client.describe()).resolves.toEqual({
      available: false,
      supported: false,
      providers: [],
      reasonCode: "paired-plugin-update-required",
      reason: expect.stringMatching(/update.*remote-web-ui/i),
    });
    await expect(client.discover({ provider: "openrouter" })).rejects.toMatchObject({ status: 409, code: "paired-model-catalog-unavailable" });
  });

  it("distinguishes a missing paired provider from an old plugin", async () => {
    const fake = await host();
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    await expect(client.discover({ provider: "missing" })).rejects.toMatchObject({ status: 404, code: "provider-not-eligible" });
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/pair/model-catalog/discover",
      "/api/pair/model-catalog",
    ]);
  });

  it.each(["discover", "upsert"] as const)("re-probes capability when paired %s reports a stale provider", async (action) => {
    const fake = await host({ pairedActionForbidden: true });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    const failure = await (action === "discover"
      ? client.discover({ provider: "openrouter" })
      : client.upsert({ provider: "openrouter", model: { id: "new/model" } })
    ).catch((error) => error);

    expect(failure).toMatchObject({ status: 404, code: "provider-not-eligible" });
    expect(String(failure)).not.toContain("stale-provider-secret-detail");
    expect(fake.requests.map((request) => request.path)).toEqual([
      `/api/pair/model-catalog/${action}`,
      "/api/pair/model-catalog",
    ]);
  });

  it.each(["discover", "upsert"] as const)("re-probes capability when paired %s finds a revoked device", async (action) => {
    const fake = await host({ pairedAuthorized: false });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    const failure = await (action === "discover"
      ? client.discover({ provider: "openrouter" })
      : client.upsert({ provider: "openrouter", model: { id: "new/model" } })
    ).catch((error) => error);

    expect(failure).toMatchObject({ status: 403, code: "paired-device-unauthorized" });
    expect(String(failure)).not.toContain("unpaired-secret-detail");
    expect(fake.requests.map((request) => request.path)).toEqual([
      `/api/pair/model-catalog/${action}`,
      "/api/pair/model-catalog",
    ]);
  });

  it("reports a revoked paired session without exposing the plugin response", async () => {
    const fake = await host({ pairedAuthorized: false });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    const failure = await client.describe().catch((error) => error);
    expect(failure).toMatchObject({ status: 403, code: "paired-device-unauthorized" });
    expect(String(failure)).not.toContain("unpaired-secret-detail");
  });

  it("rejects oversized paired model-management responses", async () => {
    const fake = await host({ pluginOversized: true });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    await expect(client.describe()).rejects.toMatchObject({ status: 502, code: "invalid-paired-response" });
  });

  it("does not follow a paired capability redirect or leak the device cookie", async () => {
    const target = await host();
    const source = await host({ pluginRedirect: `${target.baseUrl}/capture` });
    const client = new DeepSeekHarnessManagementClient({ baseUrl: source.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" });
    await expect(client.describe()).rejects.toMatchObject({ status: 502 });
    expect(target.requests).toEqual([]);
  });

  it("times out while reading a stalled paired capability response", async () => {
    const fake = await host({ pluginDelayMs: 100 });
    const client = new DeepSeekHarnessManagementClient(
      { baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_pair=device-1" },
      { timeoutMs: 20 },
    );
    await expect(client.describe()).rejects.toMatchObject({ status: 502 });
  });
});

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: DshJsonValue): void {
  res.writeHead(status, { "content-type": "application/json" });
  sendJsonBody(res, body);
}

function sendJsonBody(res: ServerResponse, body: DshJsonValue): void {
  res.end(JSON.stringify(body));
}
