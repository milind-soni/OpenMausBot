// A real server booted as a Cloud home, with a chat-only model (openai-compat, against an in-process stub that records
// what it is sent) beside Claude (the fake CLI, which dumps its turn). Case A as it happened: a bot moved to a chat-only
// model runs its routine, tries to run its script, and tells the person in its own words; the app says the real reason.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { isTitleCall } from "./testing/title-call.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const NO_TERMINAL = "You can't run commands this turn: on My Cloud this model (fixture-model) has no terminal of its own, and no cloud desktop is in use.";
const SELECT_CLOUD = "This turn has no terminal: on My Cloud this model (fixture-model) can't run commands itself. To run one, call select_computer with surface \"cloud\"";
const SENTENCE = "This run couldn't run commands: fixture-model has no terminal on My Cloud. To run them, this routine needs a model with a terminal, such as Claude or Codex, or to run on the cloud desktop.";
const BOT_SAID = "No execution environment was mounted, so sync.py did not run.";
let home = "", base = "", log = "", owner = "", claudeDump = "";
let child: ChildProcess;
let upstream: Server;
/** The tool the Case A run looked at after its refused command. */
let looked: string | undefined;

type ChatRequest = { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> };
const requests: ChatRequest[] = [];
const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const said = (request: ChatRequest, role: string) => request.messages.filter((message) => message.role === role).map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n");

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { body: { code: granted.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-no-terminal-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  claudeDump = join(home, "claude-turn.json");
  upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    if (req.method === "GET") { res.statusCode = 404; return res.end(); }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw || "{}") as ChatRequest;
    if (isTitleCall(request)) { res.statusCode = 500; return res.end(); }
    requests.push(request);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Case A: the routine's run reaches for a shell to run its script; refused, it looks at something else that works (as the
    // bot did, finding its project files), then explains in its own words. "Run lint.py" stops right after the refusal.
    const user = said(request, "user"), tools = request.messages.filter((message) => message.role === "tool").length;
    const script = user.includes("Run sync.py") || user.includes("Run lint.py");
    if (script && tools === 0) {
      const call = { index: 0, id: "exec-call", type: "function", function: { name: "exec", arguments: JSON.stringify({ command: "python3 sync.py" }) } };
      return res.end(frame({ tool_calls: [call] }, "tool_calls") + "data: [DONE]\n\n");
    }
    if (user.includes("Run sync.py") && tools === 1) {
      const names = (request.tools ?? []).map((tool) => tool.function.name), direct = names.find((name) => name.endsWith("list_bots")), bridge = names.find((name) => name.endsWith("use_tool"));
      looked = direct ?? bridge;
      const call = { index: 0, id: "look-call", type: "function", function: direct ? { name: direct, arguments: "{}" } : { name: bridge, arguments: JSON.stringify({ name: "list_bots", arguments: {} }) } };
      return res.end(frame({ tool_calls: [call] }, "tool_calls") + "data: [DONE]\n\n");
    }
    res.end(frame({ content: script ? BOT_SAID : "Filed three invoices." }, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    openaiCompat: { key: "fixture-key", url: `http://127.0.0.1:${upstreamPort}/v1`, model: "fixture-model" },
    instances: { claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") }, environment: { FAKE_CLAUDE_DUMP: claudeDump } } },
  }));
  writeFileSync(join(dataDir, "host-memory.json"), JSON.stringify({ totalBytes: 64 * 1024 ** 3, availableBytes: 60 * 1024 ** 3, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  const memoryGate = pathToFileURL(join(SERVER_DIR, "testing", "memory-gate-hooks.mjs")).href;
  child = spawn(process.execPath, ["--import", offlinePrelude, "--import", memoryGate, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir, OMB_TEST_MEMORY_GATE: "1", OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      // A cloud desktop is set up (the Admin's relay; nothing here starts one), so the app may offer it.
      OMB_CLOUD_BOAT_URL: "http://127.0.0.1:9/relay/api/box/v1", OMB_CLOUD_BOAT_TOKEN: "fixture-included",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await adminPairing();
}, hostTimeout(40_000));

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (home) await removeTempDir(home);
});

const newBot = async (name: string, instanceId: string, model: string) => {
  const made = await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId, model } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.bot as { id: string; threadId: string };
};
const chat = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`, { token: owner })).body.messages as Array<{ kind: string; text?: string; tool?: { name: string }; automation?: { routineId: string } }>;
const runs = async () => (await api("GET", "/api/routines", { token: owner })).body.runs as Array<{ id: string; routineId: string; status: string; error?: string }>;
const routineFor = async (botId: string, prompt: string) => {
  const made = await api("POST", "/api/routines", { token: owner, body: { name: prompt.slice(0, 20), prompt, botId, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.routine.id as string;
};
const runNow = async (routineId: string) => {
  expect((await api("POST", `/api/routines/${routineId}/run`, { token: owner })).status).toBe(201);
  let run: { status: string; error?: string } | undefined;
  await expect.poll(async () => (run = (await runs()).find((row) => row.routineId === routineId))?.status, { timeout: hostTimeout(20_000) }).toMatch(/^(completed|failed)$/u);
  return run!;
};

it("switching a bot with a routine from Claude to a chat-only model says once, in its chat, what its routine will no longer do", async () => {
  const bot = await newBot("Ledger", "claude", "claude-sonnet-5");
  await routineFor(bot.id, "Run sync.py from the project folder.");
  const notices = async () => (await chat(bot.threadId)).filter((line) => line.tool?.name.startsWith("notice: "));
  const moved = await api("PATCH", `/api/bots/${bot.id}`, { token: owner, body: { modelSelection: { instanceId: "openaiCompat", model: "fixture-model" } } });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect((await notices()).map((line) => line.tool!.name)).toEqual(["notice: fixture-model can't run commands on My Cloud by itself. Ledger has a routine; it will only be able to do work that needs no commands."]);
  // Back to Claude, which has a terminal: nothing more.
  expect((await api("PATCH", `/api/bots/${bot.id}`, { token: owner, body: { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).status).toBe(200);
  expect(await notices()).toHaveLength(1);
  // Must-fix 2: a bot that works on the cloud desktop keeps exec there, so its switch says nothing.
  const desk = await newBot("Desk", "claude", "claude-sonnet-5");
  await routineFor(desk.id, "Run sync.py from the project folder.");
  const onDesk = await api("PATCH", `/api/bots/${desk.id}`, { token: owner, body: { computer: "cloud" } });
  expect(onDesk.status, JSON.stringify(onDesk.body)).toBe(200);
  expect((await api("PATCH", `/api/bots/${desk.id}`, { token: owner, body: { modelSelection: { instanceId: "openaiCompat", model: "fixture-model" } } })).status).toBe(200);
  expect((await chat(desk.threadId)).filter((line) => line.tool?.name.startsWith("notice: "))).toEqual([]);
  // A bot with nothing to run moving between chat-only models: nothing either.
  const plain = await newBot("Notes", "openaiCompat", "fixture-model");
  expect((await api("PATCH", `/api/bots/${plain.id}`, { token: owner, body: { modelSelection: { instanceId: "openaiCompat", model: "other-model" } } })).status).toBe(200);
  expect((await chat(plain.threadId)).filter((line) => line.tool?.name.startsWith("notice: "))).toEqual([]);
}, hostTimeout(60_000));

it("Case A: the chat-only bot's routine is told it can't run commands, tries, and its line in the chat ends with the app's own reason; the run stays completed", async () => {
  const bot = await newBot("Syncer", "openaiCompat", "fixture-model");
  const sync = await routineFor(bot.id, "Run sync.py from the project folder.");
  requests.length = 0;
  const synced = await runNow(sync);
  expect(synced.status, `no terminal alone never fails a run: ${synced.error}\n${JSON.stringify(await chat(bot.threadId))}`).toBe("completed");
  const system = said(requests[0]!, "system");
  expect(system).toContain(NO_TERMINAL);
  expect(system).toContain("Do the parts that need no command and say which step was not done, without giving a reason for it.");
  expect(system, "a run may not move, so it is never told to").not.toContain("select_computer with surface");
  let line: string | undefined;
  await expect.poll(async () => (line = (await chat(bot.threadId)).find((message) => message.automation?.routineId === sync)?.text), { timeout: hostTimeout(15_000) }).toBeTruthy();
  // The run went on after the refusal with a call that worked, as the bot did, so it ended completed.
  expect(looked).toBeTruthy();
  const answers = requests.flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => String(message.content)));
  expect(answers.some((answer) => answer.includes("not advertised for this turn")), JSON.stringify(answers)).toBe(true);
  expect(answers.some((answer) => answer.startsWith("{\"ok\":true")), JSON.stringify(answers)).toBe(true);
  expect(line).toBe(`${BOT_SAID}\n\n${SENTENCE}`);
  // Should-fix 4: the same routine on the same model says it once; its next run's line is the bot's alone.
  expect((await runNow(sync)).status).toBe("completed");
  await expect.poll(async () => (await chat(bot.threadId)).filter((message) => message.automation?.routineId === sync).map((message) => message.text), { timeout: hostTimeout(15_000) })
    .toEqual([`${BOT_SAID}\n\n${SENTENCE}`, BOT_SAID]);

  // Should-fix 3: a run that stops on the refused call fails as before (the bot's reply is no proof), and the line saying
  // so carries the real reason too.
  const lint = await routineFor(bot.id, "Run lint.py from the project folder.");
  expect((await runNow(lint)).status).toBe("failed");
  await expect.poll(async () => (await chat(bot.threadId)).find((message) => message.automation?.routineId === lint)?.text, { timeout: hostTimeout(15_000) })
    .toBe(`This run was partly done: Stopped because the tool call “exec” failed. The bot's reply isn't proof the work was done; the failed step shows the error.\n\n${SENTENCE}`);

  // A routine that needs no command, on the same bot: the bot's words alone.
  const invoices = await routineFor(bot.id, "File the new invoices.");
  expect((await runNow(invoices)).status).toBe("completed");
  await expect.poll(async () => (await chat(bot.threadId)).find((message) => message.automation?.routineId === invoices)?.text, { timeout: hostTimeout(15_000) }).toBe("Filed three invoices.");
}, hostTimeout(90_000));

it("must-fix 1: the person's own chat, which may move, is told to select the cloud desktop; with Computer access Off it is not offered", async () => {
  const bot = await newBot("Chatter", "openaiCompat", "fixture-model");
  const ask = async (text: string) => {
    requests.length = 0;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text, threadId: bot.threadId } })).status).toBe(202);
    await expect.poll(() => requests.some((request) => said(request, "user").includes(text)), { timeout: hostTimeout(20_000) }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots", { token: owner })).body.bots.find((one: { id: string }) => one.id === bot.id)?.busy, { timeout: hostTimeout(20_000) }).toBe(false);
    return said(requests.find((request) => said(request, "user").includes(text))!, "system");
  };
  const open = await ask("Run the build.");
  expect(open).toContain(SELECT_CLOUD);
  expect(open).not.toContain("don't try another way");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { token: owner, body: { computer: "off" } })).status).toBe(200);
  const off = await ask("Run the tests.");
  expect(off).toContain(NO_TERMINAL);
  expect(off).not.toContain("select_computer with surface \"cloud\"");
  expect(off).not.toContain("or the cloud desktop");
}, hostTimeout(60_000));

it("a bot on Claude, which runs commands itself, is told nothing of the kind", async () => {
  const bot = await newBot("Builder", "claude", "claude-sonnet-5");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Run the build.", threadId: bot.threadId } })).status).toBe(202);
  let dump: { systemPrompt?: string } | undefined;
  await expect.poll(() => { try { dump = JSON.parse(readFileSync(claudeDump, "utf8")); return typeof dump?.systemPrompt === "string"; } catch { return false; } }, { timeout: hostTimeout(20_000) }).toBe(true);
  expect(dump!.systemPrompt).toContain("My Cloud");
  expect(dump!.systemPrompt).not.toContain("You can't run commands this turn");
  expect(dump!.systemPrompt).not.toContain("This turn has no terminal");
}, hostTimeout(60_000));
