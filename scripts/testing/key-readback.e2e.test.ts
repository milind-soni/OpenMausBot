// Every credential on the keys page, saved through a real server the way its row saves it, read back from GET
// /api/config and shown masked. The services that check a key before it is kept (Boat, Composio, ElevenLabs, Fish Audio
// the decision models and Postiz) answer from one loopback stand-in, so nothing leaves this machine.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

const view = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: { ...store.initialState, config: view.config, instances: [] }, dispatch: () => {} }) };
});
const { KEY_CATALOG, savedState } = await import("@/components/keys/key-catalog");
const { KeyCatalogRow } = await import("@/components/keys/KeysPage");
const { setLocale } = await import("@/lib/i18n");

const ROOT = new URL("../..", import.meta.url);
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PREFIX: Record<string, string> = { box: "boat_", composio: "ak_", elevenlabs: "sk_" };
const EXTRA_PATCH: Record<string, (key: string) => Record<string, unknown>> = {
  workersAi: (key) => ({ decider: { workersAiToken: key, workersAiAccountId: ACCOUNT_ID } }),
  imageCustom: (key) => ({ imageGen: { customApiKey: key } }),
};

let stub: Server;
let fixture: VerificationServer;
let server: ChildProcess;
const stubCalls: string[] = [];

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const url = req.url ?? "";
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    stubCalls.push(`${req.method} ${url.split("?")[0]}`);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url === "/postiz/mcp") {
      const frame = JSON.parse(raw || "{}") as { id?: number; method?: string };
      if (frame.id === undefined) { res.writeHead(202).end(); return; }
      const result = frame.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Postiz MCP", version: "1" } }
        : { tools: [{ name: "integrationList", inputSchema: { type: "object" } }] };
      return reply(200, { jsonrpc: "2.0", id: frame.id, result });
    }
    if (url.startsWith("/sandboxes")) return reply(200, { ok: true, sandboxes: [], pageInfo: { nextCursor: null } });
    if (url.startsWith("/composio/tool_router/session")) {
      return reply(201, { session_id: "trs_readback", mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_readback/mcp" }, config: { user_id: "openmausbot_readback" } });
    }
    if (url.startsWith("/eleven/voices")) return reply(200, { voices: [] });
    if (url.startsWith("/fish/model")) return reply(200, { items: [], total: 0 });
    return reply(404, { error: "not in the stand-in" });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  fixture = await launchVerificationServer();
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const configFile = join(fixture.info.dataDir, "config.json");
  const decider = { baseUrl: `${origin}/jev`, openrouterBaseUrl: `${origin}/openrouter`, workersAiBaseUrl: `${origin}/cf` };
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, "utf8")), decider }));
  const env = {
    ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
    OMB_BOAT_API: origin, OMB_COMPOSIO_API: `${origin}/composio`, OMB_COMPOSIO_TOOLKITS_API: `${origin}/composio`,
    OMB_ELEVENLABS_API: `${origin}/eleven`, OMB_FISH_AUDIO_API: `${origin}/fish`, OMB_POSTIZ_CLOUD_URL: `${origin}/postiz`,
  };
  const log = openSync(fixture.info.logPath, "a", 0o600);
  server = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(ROOT), env, stdio: ["ignore", log, log] });
  closeSync(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the server with the stand-in did not start; see ${fixture.info.logPath}`);
}, hostTimeout(90_000));

afterAll(async () => {
  if (server) await waitForExit(server, { signal: "SIGTERM" });
  await fixture?.close();
  await new Promise<void>((resolve) => stub ? stub.close(() => resolve()) : resolve());
});

const saveds = KEY_CATALOG.filter((entry) => entry.target || EXTRA_PATCH[entry.id]);

it("saves every kind of credential, reads it back and shows it masked to its last four, then removes it", async () => {
  setLocale("en");
  expect(saveds.map((entry) => entry.id)).toEqual([
    "openai", "anthropic", "xai", "openrouter", "mistral", "cerebras", "groq", "greenference", "meta", "deepseek", "opencodeGo", "openaiCompat",
    "liveKey", "elevenlabs", "fishAudio", "box", "composio", "treg", "postiz", "jev", "openrouterHelper", "workersAi", "imageOpenai", "imageCustom",
  ]);
  for (const storage of ["", "?secretStorage=external"]) {
    for (const entry of saveds) {
      if (storage && !entry.target?.slot) continue;
      const key = `${PREFIX[entry.id] ?? "fx-"}${entry.id}-${randomBytes(6).toString("hex")}`;
      const last4 = key.slice(-4);
      const patch = (value: string) => entry.target ? entry.target.patch(value, true) : EXTRA_PATCH[entry.id]!(value);
      const saved = await call("PUT", `/api/config${storage}`, patch(key));
      expect(saved.status, `${entry.id}${storage}: ${JSON.stringify(saved.body)}`).toBe(200);

      const config = (await call("GET", "/api/config")).body;
      expect(savedState(entry, config as never), `${entry.id}${storage}`).toEqual({ configured: true, last4 });
      expect(JSON.stringify(config), entry.id).not.toContain(key);
      view.config = config;
      const html = renderToStaticMarkup(createElement(KeyCatalogRow, { entry }));
      expect(html, entry.id).toContain(`••••••••${last4}`);
      expect(html, entry.id).toMatch(/>(Connected|Saved)</);
      expect(html, entry.id).not.toContain(key);

      expect((await call("PUT", `/api/config${storage}`, patch(""))).status, `${entry.id}${storage} removed`).toBe(200);
      expect(savedState(entry, (await call("GET", "/api/config")).body as never), `${entry.id}${storage} removed`).toEqual({ configured: false });
    }
  }
  expect(stubCalls).toEqual(expect.arrayContaining([
    "GET /sandboxes", "POST /composio/tool_router/session", "GET /eleven/voices", "GET /fish/model", "POST /jev/v1/systemone", "POST /alpha/decisions", "POST /postiz/mcp",
  ]));
}, hostTimeout(180_000));
