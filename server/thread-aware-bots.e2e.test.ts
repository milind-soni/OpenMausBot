// Thread-aware bots, end to end against the real harness server.
//
// A bot can open a real thread — on itself for separate work, or on a
// teammate as a handoff into a fresh thread — and the person sees each as
// a row under that bot. The claims pinned here need the whole harness: the
// per-bot slot limit deciding "runs now" against "waits in line", the chip
// and the opener record every client reads, and the same gates every peer
// path already has. Turns are held open by a gated fake CLI so the slot
// arithmetic is observable rather than raced.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "thread-aware-bots-fixture-capability";

let child: ChildProcess;
let home = "";
let gates = "";
let base = "";
let stderr = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

/** Let one held turn finish. A gate written before the turn starts lets it
 * finish the moment it does. Depth-1 turns (no agents server, so no thread
 * id in their MCP config) share the "peer" gate. */
const release = (threadId: string) => writeFileSync(join(gates, `${threadId}.gate`), "finish");
const dumpOf = (threadId: string): { systemPrompt?: string; mcpConfig?: any } | undefined => {
  try {
    return JSON.parse(readFileSync(join(gates, `${threadId}.json`), "utf8"));
  } catch {
    return undefined;
  }
};
/** The live per-turn token of a held turn — the only credential the
 * internal endpoints accept, and the one a real tool call would carry. */
const liveToken = async (threadId: string): Promise<Record<string, string>> => {
  await expect.poll(() => dumpOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN, { timeout: 15_000 }).toBeTruthy();
  return { authorization: `Bearer ${dumpOf(threadId)!.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN}` };
};
const mintedToken = async (botId: string, threadId: string, depth = 0): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind: "agents", depth },
    { "x-openmausbot-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
const botState = async (botId: string) => (await bots()).find((bot) => bot.id === botId);
const taskOf = async (botId: string, threadId: string) => (await botState(botId))?.tasks.find((task: any) => task.threadId === threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];

const createBot = async (name: string, instanceId: string, model = "claude-sonnet-5") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (botIds: string[]) => {
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-thread-aware-"));
  gates = join(home, "gates");
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  mkdirSync(gates, { recursive: true });
  // Every turn holds until its gate exists, and dumps its argv/env/prompt
  // under its thread id — the only way a test can read a live comms token
  // or a bot's assembled system prompt.
  const gated = join(home, "gated-claude.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    "let thread = null;",
    "if (at >= 0) {",
    "  try {",
    '    const servers = JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers ?? {};',
    "    for (const server of Object.values(servers)) thread ??= server?.env?.OMB_THREAD_ID ?? null;",
    "  } catch {}",
    "}",
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(gates)}, (thread ?? "peer") + ".gate");`,
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(gates)}, (thread ?? "peer") + ".json");`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    threads: { maxConcurrentPerBot: 2 },
    instances: {
      gated: {
        driver: "claudeAgent",
        displayName: "Gated fixture",
        config: { cli: gated },
      },
      // stops mid-turn to ask the person a question no rule may answer —
      // the card that has to reach a human even from a peer-opened thread
      curious: {
        driver: "grokAgent",
        displayName: "Curious fixture",
        environment: { FAKE_ACP_MODE: "question" },
        config: { cli: FAKE_ACP, fullAuto: true },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("start_thread on yourself", () => {
  it("opens a quiet thread that runs like a person's message, or waits its turn", async () => {
    const pm = await createBot("Pam", "gated");
    try {
      // the opener's own turn holds one of its two slots
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Plan the QA round." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const folder = (await api("POST", `/api/bots/${pm.id}/projects`, { name: "QA" })).body.project;

      const first = await api("POST", "/api/internal/threads", { title: "QA: PR #1", message: "Review the login fix." }, token);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ title: "QA: PR #1", botId: pm.id, self: true, state: "running", limit: 2 });
      const second = await api("POST", "/api/internal/threads", { title: "QA: PR #2", message: "Review the signup fix.", folder: "qa" }, token);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ state: "queued", position: 1 });
      const third = await api("POST", "/api/internal/threads", { title: "QA: PR #3", message: "Review the reset fix." }, token);
      expect(third.body).toMatchObject({ state: "queued", position: 2 });

      // the person's view: rows under the bot, filed where asked, stamped
      // with who opened them — and the row they were reading did not move
      const state = await botState(pm.id);
      expect(state.threadId).toBe(pm.threadId);
      const opened = state.tasks.find((task: any) => task.threadId === first.body.threadId);
      expect(opened).toMatchObject({ title: "QA: PR #1", openedBy: { botId: pm.id, name: "Pam" }, busy: true });
      expect(opened.openedBy.delegationId).toBeUndefined();
      expect(opened.resumeCursors).toBeUndefined();
      expect(await taskOf(pm.id, second.body.threadId)).toMatchObject({ projectId: folder.id, busy: false });

      // the opener's thread gets the linkable chip
      const chip = (await messages(pm.threadId)).find((message) => message.threadRef?.threadId === first.body.threadId);
      expect(chip).toMatchObject({ kind: "activity", tool: { name: "Opened thread #QA: PR #1", ok: true }, threadRef: { botId: pm.id, title: "QA: PR #1" } });

      // the new thread's first line is the bot's own words, and says so
      const opening = (await messages(first.body.threadId)).find((message) => message.role === "user");
      expect(opening.text).toContain("[Thread you opened yourself from #Plan the QA round.");
      expect(opening.text).toContain("Review the login fix.");

      // a slot frees: the line moves in order
      release(first.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, second.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await taskOf(pm.id, third.body.threadId)).busy).toBe(false);
      release(second.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, third.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      release(third.body.threadId);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
      // the queued line landed as a user message and got its reply
      expect((await messages(third.body.threadId)).some((message) => message.role === "bot" && message.text?.includes("reply to:"))).toBe(true);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  it("refuses a title that would not fit a row, a folder the bot does not have, and a sixth thread", async () => {
    const bot = await createBot("Quin", "gated");
    try {
      const token = await mintedToken(bot.id, bot.threadId);
      const twoLines = await api("POST", "/api/internal/threads", { title: "two\nlines", message: "x" }, token);
      expect(twoLines.status).toBe(400);
      expect(twoLines.body.error).toContain("fit on one line");
      const long = await api("POST", "/api/internal/threads", { title: "x".repeat(81), message: "x" }, token);
      expect(long.status).toBe(400);
      const untitled = await api("POST", "/api/internal/threads", { title: "  ", message: "x" }, token);
      expect(untitled.status).toBe(400);
      const noFolder = await api("POST", "/api/internal/threads", { title: "Filed", message: "x", folder: "Nowhere" }, token);
      expect(noFolder.status).toBe(400);
      expect(noFolder.body.error).toContain("no folder named \"Nowhere\"");
      // none of the refusals opened anything
      expect((await botState(bot.id)).tasks).toHaveLength(1);
      for (let index = 0; index < 5; index++) {
        release(`unused-${index}`);
        const opened = await api("POST", "/api/internal/threads", { title: `Job ${index}`, message: "go" }, token);
        expect(opened.status).toBe(201);
      }
      const sixth = await api("POST", "/api/internal/threads", { title: "Job 5", message: "go" }, token);
      expect(sixth.status).toBe(429);
      expect(sixth.body.error).toContain("at most 5 threads in one turn");
      expect((await botState(bot.id)).tasks).toHaveLength(6);
      for (const task of (await botState(bot.id)).tasks) release(task.threadId);
      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([bot.id]);
    }
  }, 60_000);
});
