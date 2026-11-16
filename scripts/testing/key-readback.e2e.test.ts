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
const geminiModelKeys: string[] = [];
const deepseekCalls: Array<{ url: string; authorization?: string; body: Buffer }> = [];

function pcmWav(seconds: number, rate = 16_000): Buffer {
  const data = Math.round(seconds * rate) * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF"); wav.writeUInt32LE(36 + data, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(data, 40);
  return wav;
}

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
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const raw = bytes.toString("utf8");
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
    if (url === "/gemini/interactions") {
      const input = JSON.parse(raw);
      if (req.headers["x-goog-api-key"] !== "fixture-gemini-secret" || input.generation_config.speech_config[0].voice !== "Puck") return reply(400, {});
      const wav = Buffer.alloc(46);
      wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
      return reply(200, { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }] }] });
    }
    if (url.startsWith("/gemini/models")) {
      geminiModelKeys.push(String(req.headers["x-goog-api-key"]));
      return reply(200, { models: [] });
    }
    if (url.startsWith("/deepseek/tools/")) {
      deepseekCalls.push({ url, authorization: req.headers.authorization, body: bytes });
      if (req.headers.authorization !== "Bearer fixture-deepseek-secret") return reply(401, { error: "fixture-deepseek-secret leaked text" });
      if (url === "/deepseek/tools/tts") {
        const input = JSON.parse(raw) as { text: string };
        if (input.text.includes("refuse")) return reply(429, { error: input.text });
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(pcmWav(0.25, 24_000));
        return;
      }
      return reply(200, { text: "hello from deepseek", request_id: "fixture", duration_ms: 1000 });
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
    OMB_GEMINI_TTS_API: `${origin}/gemini`, OMB_DEEPSEEK_SPEECH_API: `${origin}/deepseek`,
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
    "openai", "anthropic", "xai", "openrouter", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta", "deepseek", "opencodeGo", "openaiCompat",
    "liveKey", "elevenlabs", "geminiTts", "fishAudio", "box", "composio", "treg", "postiz", "jev", "openrouterHelper", "workersAi", "imageOpenai", "imageCustom",
  ]);
  for (const storage of ["", "?secretStorage=external"]) {
    for (const entry of saveds) {
      if (storage && !entry.target?.slot) continue;
      const key = `${PREFIX[entry.id] ?? "fx-"}${entry.id}-${randomBytes(6).toString("hex")}`;
      const last4 = key.slice(-4);
      const patch = (value: string) => entry.target ? entry.target.patch(value, true) : EXTRA_PATCH[entry.id]!(value);
      geminiModelKeys.length = 0;
      const saved = await call("PUT", `/api/config${storage}`, patch(key));
      expect(saved.status, `${entry.id}${storage}: ${JSON.stringify(saved.body)}`).toBe(200);
      for (const sent of geminiModelKeys) expect(sent, `${entry.id}${storage} verification key`).toBe(key);

      const config = (await call("GET", "/api/config")).body;
      expect(savedState(entry, config as never), `${entry.id}${storage}`).toEqual({ configured: true, last4 });
      if (storage) expect(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"), `${entry.id} config.json`).not.toContain(key);
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

it("configures Gemini speech and synthesizes WAV through the isolated server", async () => {
  geminiModelKeys.length = 0;
  expect((await call("PUT", "/api/config", { tts: { provider: "gemini", geminiKey: "fixture-gemini-secret", voice: "Kore" } })).status).toBe(200);
  expect(geminiModelKeys).toEqual(["fixture-gemini-secret"]);
  const status = (await call("GET", "/api/config")).body;
  expect(status.tts).toMatchObject({ provider: "gemini", configured: true, ready: true, model: "gemini-3.8-flash-lite-tts" });
  expect(JSON.stringify(status)).not.toContain("fixture-gemini-secret");
  expect((await call("POST", "/api/tts/prepare", { text: "Hello", voiceId: "invalid" })).body.ready).toBe(false);
  expect((await call("POST", "/api/tts/prepare", { text: "Hello", voiceId: "" })).body.ready).toBe(true);
  expect((await call("PUT", "/api/config", { tts: { voice: "invalid" } })).body.tts).toMatchObject({ configured: true, ready: false });
  expect((await call("POST", "/api/tts/prepare", { text: "Hello" })).body.ready).toBe(false);
  expect((await call("POST", "/api/tts/prepare", { text: "Hello", voiceId: "Puck" })).body.ready).toBe(true);
  expect((await call("PUT", "/api/config", { tts: { voice: "Kore" } })).status).toBe(200);
  expect((await call("GET", "/api/tts/voices")).body.voices).toEqual(expect.arrayContaining([{ id: "Puck", label: "Puck" }]));
  const response = await fetch(`${fixture.info.url}/api/tts/speak`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ text: "Hello from the fixture", voiceId: "Puck" }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(Buffer.from(await response.arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
  expect((await call("PUT", "/api/config", { tts: { provider: "chatterbox", model: "fixture-local-model" } })).status).toBe(200);
  expect((await call("PUT", "/api/config", { tts: { provider: "gemini" } })).body.tts).toMatchObject({ voice: "", model: "gemini-3.8-flash-lite-tts" });
  console.log(JSON.stringify({ geminiSpeech: "passed", fixture: fixture.info }));
});

it("speaks and hears through DeepSeek with the existing DeepSeek key on the isolated server", async () => {
  const speak = (body: unknown) => fetch(`${fixture.info.url}/api/tts/speak`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body) });
  const hear = (audio: Buffer) => fetch(`${fixture.info.url}/api/tts/transcribe`, { method: "POST", headers: { "content-type": "audio/wav", origin: fixture.info.url }, body: audio });
  deepseekCalls.length = 0;
  expect((await call("PUT", "/api/config", { tts: { provider: "elevenlabs" }, deepseek: { key: "fixture-deepseek-secret" } })).status).toBe(200);
  const chosen = (await call("PUT", "/api/config", { tts: { provider: "deepseek", fishKey: "" } })).body;
  expect(chosen.tts).toMatchObject({ provider: "deepseek", configured: true, ready: true, voice: "stella" });
  expect(JSON.stringify(chosen)).not.toContain("fixture-deepseek-secret");
  expect((await call("GET", "/api/tts/voices")).body.voices).toEqual([{ id: "stella", label: "Stella (female)" }, { id: "tide", label: "Tide (male)" }]);
  expect((await call("PUT", "/api/config", { tts: { voice: "tide" } })).body.tts).toMatchObject({ voice: "tide", ready: true });
  expect((await call("GET", "/api/config")).body.tts).toMatchObject({ provider: "deepseek", voice: "tide" });

  const sample = await speak({ text: "Hello from the fixture", voiceId: "stella" });
  expect(sample.status).toBe(200);
  expect(sample.headers.get("content-type")).toBe("audio/wav");
  expect(Buffer.from(await sample.arrayBuffer()).equals(pcmWav(0.25, 24_000))).toBe(true);
  expect(JSON.parse(deepseekCalls.at(-1)!.body.toString())).toEqual({ text: "Hello from the fixture", voice_id: "stella", format: "wav", filter_markdown: true });
  expect((await speak({ text: "Fallback", voiceId: "elevenlabs-voice" })).status).toBe(200);
  expect(JSON.parse(deepseekCalls.at(-1)!.body.toString()).voice_id).toBe("tide");
  const refused = await speak({ text: "please refuse this" });
  expect(refused.status).toBe(502);
  expect(JSON.stringify(await refused.json())).not.toContain("please refuse");

  const heard = await hear(pcmWav(2));
  expect(heard.status).toBe(200);
  expect(await heard.json()).toEqual({ text: "hello from deepseek" });
  expect(deepseekCalls.at(-1)!.url).toBe("/deepseek/tools/asr");
  expect(deepseekCalls.at(-1)!.body.toString("latin1")).toContain('name="file"; filename="speech.wav"');
  const callsBefore = deepseekCalls.length;
  expect((await hear(pcmWav(121))).status).toBe(413);
  expect((await hear(Buffer.from("not audio"))).status).toBe(400);
  expect(deepseekCalls.length).toBe(callsBefore);

  expect((await call("PUT", "/api/config", { deepseek: { key: "" } })).body.tts).toMatchObject({ provider: "deepseek", configured: false });
  const missing = await hear(pcmWav(1));
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ errorKey: "serverError.voice.deepseekKeyRequired" });
  expect((await call("PUT", "/api/config", { deepseek: { key: "fixture-deepseek-secret" } })).body.tts).toMatchObject({ configured: true, ready: true });
  expect((await hear(pcmWav(1))).status).toBe(200);
  expect((await call("PUT", "/api/config", { tts: { provider: "fish" } })).body.tts).toMatchObject({ provider: "fish", voice: "" });
  expect(await (await hear(pcmWav(1))).json()).toMatchObject({ errorKey: "serverError.voice.fishKeyRequired" });
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("fixture-deepseek-secret");
  console.log(JSON.stringify({ deepseekSpeech: "passed", fixture: fixture.info }));
});
