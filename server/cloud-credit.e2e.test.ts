// The full server as an OpenMausBot Cloud home with the free trial's Claude
// credit, over its real HTTP boundary, against one stub that plays the
// Admin's relay: an OpenAI-compatible API (chat completions and models) and
// nothing Anthropic-shaped. With no AI of the person's own, the first bot
// runs on the credit: a read-only engine, OpenMausBot's own chat engine,
// whose token reaches only the relay, never config.json, a page, the log,
// Claude Code or the person's own engine. Used up, it says so in plain words
// and stops; once the person's own Claude can run, it takes over every bot.
// Disposable home; a synthetic Claude CLI for the person's own engine; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { CLOUD_CREDIT_INSTANCE } from "./cloud-credit-provider.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { TRIAL_CREDIT_OWN_AI, TRIAL_CREDIT_REFUSED } from "./trial-credit.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const TOKEN = `omb_ai_${randomBytes(32).toString("base64url")}`;
/** The Admin's relay, as server/cloud-credit.ts serves it: CREDIT_RELAY_PATH, with the Cloud given `<origin>${RELAY_PATH}/v1`. */
const RELAY_PATH = "/api/cloud/services/ai";
const MODELS = { object: "list", data: [
  { object: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
  { object: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
] };
/** The relay's answer once the credit is spent, exactly as the Admin writes it: its code first. */
const USED_UP = { error: { code: "trial_credit_used_up", type: "insufficient_quota",
  message: "Your $5 of Claude credit is used up. To keep your bots working, connect your own Claude or ChatGPT account, or an API key, on your Cloud.", param: null } };
const relayed: Array<{ method: string; path: string; bearer: string; apiKey: string }> = [];
let usedUp = false;
let stub: Server;
let home: string;
let data: string;
let base: string;
let child: ChildProcess;
let log = "";
let ownerToken = "";

async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const asOwner = !options.remote && ownerToken !== "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.remote || asOwner ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(asOwner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub.test");
      relayed.push({ method: req.method ?? "", path: url.pathname, bearer: String(req.headers.authorization ?? ""), apiKey: String(req.headers["x-api-key"] ?? "") });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      // Only its two routes answer, whatever the token: everything else is 404, as the Admin's route() answers.
      const routed = (req.method === "GET" && url.pathname === `${RELAY_PATH}/v1/models`) || (req.method === "POST" && url.pathname === `${RELAY_PATH}/v1/chat/completions`);
      if (!routed) return send(404, { error: { code: "not_found", type: "invalid_request_error", message: "Claude credit offers only chat completions and its model list.", param: null } });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "invalid_api_key", type: "invalid_request_error", message: "This Claude credit key isn't valid.", param: null } });
      if (req.method === "GET" && url.pathname === `${RELAY_PATH}/v1/models`) return send(200, MODELS);
      if (req.method === "POST" && url.pathname === `${RELAY_PATH}/v1/chat/completions`) {
        if (usedUp) return send(402, USED_UP);
        return send(200, { id: "chatcmpl-1", object: "chat.completion", model: "claude-haiku-4-5",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from the trial credit." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 6 } });
      }
      // The relay serves nothing Anthropic-shaped for a credit token.
      send(404, { error: { type: "not_found", message: "Not found" } });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  // OMB_CLOUD_AI_URL exactly as the Admin builds it (cloud-credit.ts `env`): the origin, the relay path and `/v1`.
  const relayUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}${RELAY_PATH}/v1`;

  home = mkdtempSync(join(tmpdir(), "omb-cloud-credit-"));
  data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  // The person's own Claude Code, as on the image: signed out until the test
  // signs the person in. Each turn is a fresh process, which records its
  // environment; the credit's engine never runs it.
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
const home = ${JSON.stringify(home)};
process.env.FAKE_CLAUDE_AUTH = existsSync(join(home, "signed-in")) ? "in" : "inherited-api-key";
process.env.FAKE_CLAUDE_ROUTER_PING = "1";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
if (!["auth", "--version", "--help"].includes(process.argv[2] ?? "")) process.env.FAKE_CLAUDE_DUMP = join(home, "own-turn.json");
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      // Pin the fleet's other defaults so this never probes an installed CLI.
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
    // New bots' saved default, on the credit (as a person who picked it while it was all there was).
    defaultModelSelection: { instanceId: CLOUD_CREDIT_INSTANCE, model: "claude-haiku-4-5" },
  }));
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_CLOUD_AI_URL: relayUrl, OMB_CLOUD_AI_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  ownerToken = (await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } })).body.token as string;
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (home) await removeTempDir(home);
});

type Instance = { instanceId: string; readOnly?: boolean; trialCredit?: string; snapshot: { state: string; authenticated?: boolean; reason?: string }; models: { default: string } };
type Bot = { id: string; busy?: boolean; modelSelection: { instanceId: string; model: string }; messages: Array<{ role: string; kind: string; tool?: { name: string; setup?: boolean } }> };
const instances = async () => (await api("GET", "/api/instances")).body.instances as Instance[];
const credit = async () => (await instances()).find((instance) => instance.instanceId === CLOUD_CREDIT_INSTANCE);
const bots = async () => (await api("GET", "/api/bots?messages=20")).body.bots as Bot[];
/** One message to the first bot, and its settled turn. */
async function turn(text: string): Promise<Bot> {
  const [first] = await bots();
  const before = first!.messages.length;
  expect((await api("POST", `/api/bots/${first!.id}/messages`, { body: { text } })).status).toBe(202);
  let settled: Bot | undefined;
  await expect.poll(async () => {
    settled = (await bots()).find((bot) => bot.id === first!.id);
    return Boolean(settled && !settled.busy && settled.messages.length > before + 1);
  }, { timeout: 20_000, interval: 150 }).toBe(true);
  return settled!;
}

describe("the free trial's Claude credit on a Cloud home", { timeout: 90_000 }, () => {
  it("is a read-only engine on the relay's models, and the first bot runs on it while the person has no AI of their own", async () => {
    expect(await credit()).toMatchObject({ readOnly: true, trialCredit: "active", snapshot: { state: "available", authenticated: true }, models: { default: "claude-haiku-4-5" } });
    expect((await instances()).find((instance) => instance.instanceId === "claude")?.snapshot.authenticated).toBe(false);
    const [first] = await bots();
    expect(first!.modelSelection).toEqual({ instanceId: CLOUD_CREDIT_INSTANCE, model: "claude-haiku-4-5" });
    expect(relayed).toContainEqual(expect.objectContaining({ method: "GET", path: `${RELAY_PATH}/v1/models`, bearer: `Bearer ${TOKEN}` }));
  });

  it("runs a turn on OpenMausBot's own chat engine through the relay's chat completions: never Claude Code, never an Anthropic route", async () => {
    const settled = await turn("hello");
    expect(settled.messages.some((message) => message.role === "bot" && message.kind === "text")).toBe(true);
    expect(relayed).toContainEqual(expect.objectContaining({ method: "POST", path: `${RELAY_PATH}/v1/chat/completions`, bearer: `Bearer ${TOKEN}` }));
    // Only the relay's two routes, never `/v1/v1` (which its route() answers 404) and never an Anthropic route.
    expect(relayed.filter((request) => ![`${RELAY_PATH}/v1/models`, `${RELAY_PATH}/v1/chat/completions`].includes(request.path))).toEqual([]);
    expect(relayed.every((request) => request.apiKey === "")).toBe(true);
    // The person's own Claude Code never ran for it.
    expect(() => readFileSync(join(home, "own-turn.json"), "utf8")).toThrow();
  });

  it("keeps its token to the relay: never saved, shown or logged", async () => {
    expect(readFileSync(join(data, "config.json"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(data, "providers", "trial-credit", "state.json"), "utf8")).not.toContain(TOKEN);
    for (const path of ["/api/config", "/api/instances", "/api/bots?messages=20"]) expect((await api("GET", path)).text).not.toContain(TOKEN);
    expect(log).not.toContain(TOKEN);
  });

  it("once the person's own Claude can run, it takes over every bot, and the credit is not an engine for bots any more", async () => {
    writeFileSync(join(home, "signed-in"), "");
    // Reading the engines is where the server learns the person's own AI can run.
    await expect.poll(async () => (await instances()).find((instance) => instance.instanceId === "claude")?.snapshot.authenticated, { timeout: 15_000 }).toBe(true);
    expect((await credit())?.snapshot).toEqual({ state: "unavailable", reason: TRIAL_CREDIT_OWN_AI });
    expect((await credit())?.trialCredit).toBe("active");
    const [first] = await bots();
    expect(first!.modelSelection.instanceId).toBe("claude");
    expect(first!.messages.filter((message) => message.tool?.name === "notice: Claude is connected, so this conversation uses it now instead of the trial Claude credit.")).toHaveLength(1);
    // The saved default for new bots moved too.
    expect(JSON.parse(readFileSync(join(data, "config.json"), "utf8")).defaultModelSelection.instanceId).toBe("claude");
    const completions = relayed.filter((request) => request.path.endsWith("/chat/completions")).length;
    const settled = await turn("now on my own");
    const after = settled.messages.slice(settled.messages.findLastIndex((message) => message.role === "user"));
    expect(after.some((message) => message.role === "bot" && message.kind === "text")).toBe(true);
    expect(after.some((message) => message.tool?.name.startsWith("error:"))).toBe(false);
    // Their own Claude Code ran it, with nothing of the credit's.
    const { env } = JSON.parse(readFileSync(join(home, "own-turn.json"), "utf8"));
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(JSON.stringify(env)).not.toContain(TOKEN); expect(JSON.stringify(env)).not.toContain(RELAY_PATH);
    expect(relayed.filter((request) => request.path.endsWith("/chat/completions"))).toHaveLength(completions);
    // Read again, nothing moves twice.
    await instances();
    expect((await bots())[0]!.messages.filter((message) => message.tool?.name.startsWith("notice: Claude is connected"))).toHaveLength(1);
  });

  it("used up, the bot says so in plain words, as a sign-in to make, and the credit stops offering itself, across a restart's record", async () => {
    // Signed out again, nothing of the person's own can run: the credit is offered again, to a new bot.
    rmSync(join(home, "signed-in"), { force: true });
    await expect.poll(async () => (await credit())?.snapshot.state, { timeout: 15_000 }).toBe("available");
    const created = await api("POST", "/api/bots", { body: { name: "On the credit", modelSelection: { instanceId: CLOUD_CREDIT_INSTANCE, model: "claude-sonnet-5" }, requireAvailableModel: true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    usedUp = true;
    expect((await api("POST", `/api/bots/${created.body.bot.id}/messages`, { body: { text: "one more" } })).status).toBe(202);
    let failed: Bot["messages"][number] | undefined;
    await expect.poll(async () => {
      const bot = (await bots()).find((entry) => entry.id === created.body.bot.id);
      failed = bot && !bot.busy ? bot.messages.findLast((message) => message.tool?.name.startsWith("error:")) : undefined;
      return Boolean(failed);
    }, { timeout: 20_000, interval: 150 }).toBe(true);
    expect(failed!.tool).toMatchObject({ name: `error: ${TRIAL_CREDIT_REFUSED.used_up}`, setup: true });
    const transcript = (await api("GET", "/api/bots?messages=50")).text;
    expect(transcript).not.toContain("insufficient_quota"); expect(transcript).not.toContain("HTTP 402");
    await expect.poll(async () => (await credit())?.trialCredit, { timeout: 10_000 }).toBe("used_up");
    expect((await credit())?.snapshot).toEqual({ state: "unavailable", reason: TRIAL_CREDIT_REFUSED.used_up });
    const record = JSON.parse(readFileSync(join(data, "providers", "trial-credit", "state.json"), "utf8"));
    expect(record.refused).toBe("used_up");
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(log).not.toContain(TOKEN);
  });
});
