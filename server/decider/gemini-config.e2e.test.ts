import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR, loadConfig, saveConfig, stripWorkspaceCredentialEnv, syncCredentialEnv, type AppConfig } from "../config.ts";
import { nestedKeyStatus } from "../key-hint.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "../routes/config.ts";
import { createDeciderRoutes } from "../routes/decider.ts";
import { createHelperToolRoutes } from "../routes/helper-tools.ts";
import { PASS, type RouteContext } from "../routes/table.ts";
import { createDecider, describeDecider } from "./index.ts";
import { GEMINI_DECIDER_URL } from "./gemini.ts";

const KEY = "gemini-fixture-secret-123456789";
let base: string;
let server: Server;
let cfg: AppConfig;
let configRoute: ReturnType<typeof createConfigRoutes>;
let testRoute: ReturnType<typeof createDeciderRoutes>;
let helperRoute: ReturnType<typeof createHelperToolRoutes>;
let status = 200;
const calls: Array<{ url: string; key: string | null; authorization: string | null; body: any }> = [];
const fetchGoogle: typeof fetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  calls.push({ url: String(url), key: headers.get("x-goog-api-key"), authorization: headers.get("authorization"), body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify(status === 200 ? { answers: { answer: { type: "noul", noul: 0.9 } }, usage: { total_input_tokens: 10 } } : { error: KEY }), { status });
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url!, base);
      const json = (_res: unknown, code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const ctx = { req, res, url, path: url.pathname, method: req.method!, auth: {}, json, readBody: async () => body } as unknown as RouteContext;
      if (await configRoute(ctx) !== PASS || await testRoute(ctx) !== PASS) return;
      const result = await helperRoute({ method: req.method!, path: url.pathname, res, json, botId: "fixture", readBody: async () => body, folders: async () => ({ roots: [DATA_DIR], vmWorkspace: null }) });
      if (result === PASS) json(res, 404, {});
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
afterEach(() => { stripWorkspaceCredentialEnv(process.env); });

beforeEach(() => {
  stripWorkspaceCredentialEnv(process.env);
  status = 200;
  calls.length = 0;
  saveConfig({ decider: { provider: "gemini", enabled: false, geminiKey: "", geminiKeySource: "own" }, tts: { geminiKey: "" }, imageGen: { geminiKey: "" } });
  cfg = loadConfig();
  const decider = createDecider({ config: () => cfg, fetch: fetchGoogle });
  const configStatus = () => ({ decider: describeDecider(cfg), savedKeys: nestedKeyStatus(cfg) });
  configRoute = createConfigRoutes({
    cfg, decider, configStatus, configForAccess: (value: Record<string, unknown>) => value,
    store: { bots: [] }, registry: { forgetSnapshots: vi.fn() },
    providerConfigBusy: { get: () => false, set: vi.fn() },
    browserRuntime: { heldBy: () => false },
    computerProviderConfigTransitions: new Set(),
    lendingEnabled: () => true, providerConfigs: () => ({}),
    revokeEngineCapabilities: vi.fn(), broadcast: vi.fn(),
  } as unknown as ConfigRouteDeps);
  testRoute = createDeciderRoutes({ decider, config: () => cfg });
  helperRoute = createHelperToolRoutes({ decider, extractor: { extract: vi.fn() } });
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  expect(text).not.toContain(KEY);
  return { status: res.status, body: JSON.parse(text) };
};

describe("Gemini decisions through isolated HTTP routes", () => {
  it("switches between Gemini and a custom endpoint without mixing their settings or credentials", async () => {
    const customKey = "custom-fixture-secret";
    const customBaseUrl = "https://gateway.example.com/v1";
    expect((await api("PUT", "/api/config", { decider: { geminiKey: KEY } })).status).toBe(200);
    const custom = await api("PUT", "/api/config", { decider: { provider: "custom", customKey, customBaseUrl, customModel: "decision-model-1", customApi: "systemone" } });
    expect(custom.status).toBe(200);
    expect(custom.body.decider).toMatchObject({ provider: "custom", configured: true, baseUrl: customBaseUrl, model: "decision-model-1", api: "systemone" });
    expect(JSON.stringify(custom.body)).not.toContain(customKey);
    expect((await api("POST", "/api/decider/test", {})).body.ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: `${customBaseUrl}/systemone`, key: null, authorization: `Bearer ${customKey}`, body: { model: "decision-model-1" } });
    expect((await api("PUT", "/api/config", { decider: { provider: "gemini" } })).body.decider).toMatchObject({ provider: "gemini", configured: true, geminiKeySource: "own" });
    expect((await api("POST", "/api/decider/test", {})).body.ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: GEMINI_DECIDER_URL, key: KEY, authorization: null });
    expect((await api("PUT", "/api/config", { decider: { provider: "custom" } })).body.decider).toMatchObject({ provider: "custom", configured: true, baseUrl: customBaseUrl, model: "decision-model-1" });
    expect((await api("POST", "/api/decider/test", {})).body.ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: `${customBaseUrl}/systemone`, key: null, authorization: `Bearer ${customKey}` });
  });

  it("saves and tests a separate key, answers a bot, then clears it", async () => {
    expect((await api("PUT", "/api/config", { decider: { geminiKey: KEY } })).status).toBe(200);
    expect((await api("POST", "/api/decider/test", {})).body.ok).toBe(true);
    const decision = await api("POST", "/api/internal/helpers/decide", { state: "The item arrived broken.", questions: { answer: { type: "yesno", instructions: "Is it damaged?" } } });
    expect(decision.status).toBe(200);
    expect(decision.body.text).toContain("Gemini Decision 1");
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)!.body.input).toBe("The item arrived broken.");
    expect(calls.every((call) => call.url === GEMINI_DECIDER_URL && call.key === KEY)).toBe(true);
    expect((await api("PUT", "/api/config", { decider: { geminiKey: "" } })).body.decider).toMatchObject({ configured: false, enabled: false });
  });

  it("references, replaces and loses a saved speech key without copying it", async () => {
    saveConfig({ tts: { geminiKey: KEY } });
    Object.assign(cfg, loadConfig());
    const saved = await api("PUT", "/api/config", { decider: { geminiKeySource: "speech" } });
    expect(saved.status).toBe(200);
    expect(saved.body.decider).toMatchObject({ configured: true, enabled: true, geminiKeySource: "speech" });
    expect(calls[0]!.key).toBe(KEY);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.decider.geminiKey).toBe("");
    saveConfig({ tts: { geminiKey: "replacement" } });
    Object.assign(cfg, loadConfig());
    await api("POST", "/api/decider/test", {});
    expect(calls.at(-1)!.key).toBe("replacement");
    saveConfig({ tts: { geminiKey: "" } });
    Object.assign(cfg, loadConfig());
    expect((await api("GET", "/api/config")).body.decider).toMatchObject({ configured: false, geminiKeySource: "speech" });
    expect((await api("POST", "/api/decider/test", {})).body).toMatchObject({ ok: false, reason: "no_key" });
    expect(calls).toHaveLength(2);
  });

  it("verifies image reuse before saving, rejects unavailable sources and retains the previous source on failure", async () => {
    expect((await api("PUT", "/api/config", { decider: { geminiKeySource: "images" } })).status).toBe(400);
    expect(cfg.decider?.geminiKeySource).toBe("own");
    saveConfig({ imageGen: { geminiKey: KEY } });
    Object.assign(cfg, loadConfig());
    status = 429;
    expect((await api("PUT", "/api/config", { decider: { geminiKeySource: "images" } })).status).toBe(400);
    expect(cfg.decider?.geminiKeySource).toBe("own");
    status = 200;
    expect((await api("PUT", "/api/config", { decider: { geminiKeySource: "images" } })).status).toBe(200);
    expect(cfg.decider?.geminiKeySource).toBe("images");
  });

  it("rejects invalid keys and tombstones desktop secrets instead of writing plaintext", async () => {
    status = 403;
    expect((await api("PUT", "/api/config", { decider: { geminiKey: KEY } })).body.code).toBe("decider_rejected");
    expect(cfg.decider?.geminiKey).toBe("");
    status = 200;
    expect((await api("PUT", "/api/config?secretStorage=external", { decider: { geminiKey: KEY } })).status).toBe(200);
    expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).not.toContain(KEY);
    expect(loadConfig().decider?.geminiKey).toBe(KEY);
    syncCredentialEnv({ decider: { geminiKey: "" } });
  });
});
