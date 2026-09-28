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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

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
const promptsOf = (threadId: string): any[] => {
  try {
    return readFileSync(join(gates, `${threadId}.prompts.jsonl`), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
};
/** The live per-turn token of a held turn — the only credential the
 * internal endpoints accept, and the one a real tool call would carry. */
const liveToken = async (threadId: string): Promise<Record<string, string>> => {
  await expect.poll(() => dumpOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN, { timeout: 15_000 }).toBeTruthy();
  return { authorization: `Bearer ${dumpOf(threadId)!.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN}` };
};
/** Hold a fresh turn open on a bot's own thread and hand back its live
 * token. A wake that lands on that thread cannot start while this turn
 * runs, so the token stays valid for as long as the test holds the gate —
 * the way a real tool call reads the ledger. */
const heldTurn = async (bot: { id: string; threadId: string }, text: string): Promise<Record<string, string>> => {
  // idle first: an earlier turn still finishing must find its gate
  await expect.poll(async () => Boolean((await botState(bot.id))?.busy), { timeout: 15_000 }).toBe(false);
  rmSync(join(gates, `${bot.threadId}.gate`), { force: true });
  rmSync(join(gates, `${bot.threadId}.json`), { force: true });
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status).toBe(202);
  expect(sent.body.queued).toBeUndefined();
  return liveToken(bot.threadId);
};
/** Exercise the actual provider-mounted proxy, not a test-minted capability. */
const proxyCall = async (threadId: string, name: string, args: Record<string, unknown>) => {
  await liveToken(threadId);
  const server = dumpOf(threadId)!.mcpConfig.mcpServers.agents;
  const proxy = spawn(server.command, server.args, { cwd: ROOT, env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: proxy.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Mounted proxy ${name} timed out`)), 15_000);
      lines.on("line", line => {
        try {
          const response = JSON.parse(line);
          if (response.error) { reject(new Error(JSON.stringify(response.error))); return; }
          if (response.id === 1) {
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
          }
          if (response.id === 2) resolve(response.result);
        } catch { reject(new Error("Mounted proxy returned malformed JSON")); }
      });
      proxy.once("error", reject);
      proxy.once("exit", (code, signal) => reject(new Error(`Mounted proxy exited before replying: ${signal ?? code}`)));
      proxy.stdin.on("error", reject);
      proxy.stderr.resume();
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "thread-fixture", version: "1" } } }) + "\n");
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    proxy.stdin.destroy();
    await waitForExit(proxy, { signal: "SIGTERM" });
  }
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
const handoffs = (): any[] => JSON.parse(readFileSync(join(home, ".openmausbot", "room-handoffs.json"), "utf8"));
const coordinated = async (headers: Record<string, string>, botId: string, message: string, requestKey: string) => {
  const response = await api("POST", "/api/internal/coordinate-bots", { botIds: [botId], message, requestKey }, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.accepted).toHaveLength(1);
  return handoffs().find(node => node.id === response.body.accepted[0].requestId);
};

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
  // under its gate key — the only way a test can read a live comms token
  // or a bot's assembled system prompt. The key is a [[gate:NAME]] marker
  // in the first prompt line when the test put one there, else the agents
  // server's thread id (depth-0 turns only), else "peer". Depth-1 turns
  // carry no thread id anywhere in argv or env, so the marker is what lets
  // two of a peer's threads be held and released separately.
  const gated = join(home, "gated-claude.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { PassThrough } from "node:stream";',
    'const at = process.argv.indexOf("--mcp-config");',
    "let thread = null;",
    "if (at >= 0) {",
    "  try {",
    '    const servers = JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers ?? {};',
    "    for (const server of Object.values(servers)) thread ??= server?.env?.OMB_THREAD_ID ?? null;",
    "  } catch {}",
    "}",
    "const relay = new PassThrough();",
    "const real = process.stdin;",
    'Object.defineProperty(process, "stdin", { value: relay, configurable: true });',
    "let decided = false;",
    'let held = "";',
    'real.on("data", (chunk) => {',
    "  if (decided) { relay.write(chunk); return; }",
    "  held += chunk;",
    '  const nl = held.indexOf("\\n");',
    "  if (nl === -1) return;",
    "  const marker = /\\[\\[gate:([\\w-]+)\\]\\]/.exec(held.slice(0, nl));",
    '  const key = marker?.[1] ?? thread ?? "peer";',
    `  process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(gates)}, key + ".gate");`,
    `  process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(gates)}, key + ".json");`,
    `  process.env.FAKE_CLAUDE_PROMPTS = join(${JSON.stringify(gates)}, key + ".prompts.jsonl");`,
    "  decided = true;",
    "  relay.write(held);",
    '  held = "";',
    "});",
    'real.on("end", () => relay.end());',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
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

      // Bot-origin work cannot recursively expand its own thread tree, either
      // through the mounted MCP proxy or by calling the internal API directly.
      const recursive = { title: "Recursive job", message: "Open another job." };
      await expect(proxyCall(first.body.threadId, "start_thread", recursive)).rejects.toThrow("Unknown tool: start_thread");
      expect((await api("POST", "/api/internal/threads", recursive, await liveToken(first.body.threadId))).status).toBe(409);

      // a slot frees: the line moves in order
      release(first.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, second.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await taskOf(pm.id, third.body.threadId)).busy).toBe(false);
      await expect(proxyCall(second.body.threadId, "start_thread", recursive)).rejects.toThrow("Unknown tool: start_thread");
      expect((await api("POST", "/api/internal/threads", recursive, await liveToken(second.body.threadId))).status).toBe(409);
      release(second.body.threadId);
      await expect.poll(async () => (await taskOf(pm.id, third.body.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      release(third.body.threadId);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
      // the queued line landed as a user message and got its reply
      expect((await messages(third.body.threadId)).some((message) => message.role === "bot" && message.text?.includes("reply to:"))).toBe(true);
      // A real user follow-up on that same child is new authority, not the
      // inherited bot-origin turn. Its actual proxy can open a separate job.
      await heldTurn({ id: pm.id, threadId: first.body.threadId }, "Please start a separate follow-up job.");
      const followUp = await proxyCall(first.body.threadId, "start_thread", { title: "User follow-up", message: "A separately requested check." });
      expect(followUp.isError).not.toBe(true);
      expect((await botState(pm.id)).tasks.some((task: any) => task.title === "User follow-up")).toBe(true);
    } finally {
      await cleanup([pm.id]);
    }
  }, 60_000);

  it("refuses a title that would not fit a row, a folder the bot does not have, and a sixth thread", async () => {
    const bot = await createBot("Quin", "gated");
    try {
      const token = await heldTurn(bot, "Open separate checks.");
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

describe("coordinate_bots on a teammate", () => {
  it.each([1, 2])("runs three recipient threads within capacity %i, returns all results, and leaves the person's selected thread untouched", async (capacity) => {
    expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: capacity } })).status).toBe(200);
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    const stream = await openSse(`${base}/api/events`);
    try {
      const originalConversation = await messages(qa.threadId);
      const token = await heldTurn(pm, "Hand the pull requests to QA.");
      const opened: any[] = [];
      for (let index = 1; index <= 3; index++) {
        opened.push(await coordinated(token, qa.id, `Test pull request ${index}.`, `pr-${index}`));
      }
      const before = await botState(qa.id);
      expect(before.threadId).toBe(qa.threadId);
      for (const [index, thread] of opened.entries()) {
        expect(index < capacity ? ["queued", "running"] : ["queued"]).toContain(thread.status);
        expect(before.tasks.find((task: any) => task.threadId === thread.threadId)).toMatchObject({
          openedBy: { botId: pm.id, name: "Pam" },
        });
        // A thread within capacity can be dispatched at any moment after its
        // handoff is accepted; only threads beyond it are guaranteed to stay
        // queued — and so without a dump — while the source turn is held.
        if (index >= capacity) expect(dumpOf(thread.threadId)).toBeUndefined();
      }
      const chips = (await messages(pm.threadId)).filter((message) => message.threadRef);
      expect(chips.map((chip) => [chip.tool.name, chip.threadRef.botId, chip.threadRef.threadId])).toEqual(
        opened.map((thread) => ["Sent to Quinn", qa.id, thread.threadId]),
      );
      // Ending the source admits only as many independent threads as fit.
      // Hold every admitted turn so both parallelism and queueing are observable.
      release(pm.threadId);
      for (let index = 0; index < opened.length; index++) {
        const thread = opened[index];
        await liveToken(thread.threadId);
        const running = Math.min(capacity, opened.length - index);
        await expect.poll(() => handoffs().filter(node => node.botId === qa.id && node.status === "running").length, { timeout: 15_000 }).toBe(running);
        expect(handoffs().filter(node => node.botId === qa.id && node.status === "queued")).toHaveLength(opened.length - index - running);
        const request = (await messages(thread.threadId)).find((message) => message.roomRequest?.phase === "request");
        expect(request).toMatchObject({ from: { botId: pm.id }, roomRequest: { id: thread.id } });
        expect(request.text).toContain(`Test pull request ${index + 1}.`);
        expect(dumpOf(thread.threadId)?.systemPrompt).toContain("coordinate_bots");
        expect((await api("POST", "/api/internal/threads", { title: "Recursive work", message: "go" }, await liveToken(thread.threadId))).status).toBe(409);
        release(thread.threadId);
        await expect.poll(() => handoffs().find(node => node.id === thread.id)?.status, { timeout: 15_000 }).toBe("completed");
      }
      await expect.poll(async () => (await messages(pm.threadId)).filter(
        (message) => message.from?.botId === qa.id && message.roomRequest?.phase === "result",
      ).length, { timeout: 20_000 }).toBe(3);
      // A source waiting on teammates is idle, not busy (#1610). Settled
      // means the resumed review turn itself has ended.
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      expect(promptsOf(pm.threadId).at(-1)?.message.content).toContain("Your downstream room requests have settled");
      expect(stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === qa.id)).toEqual([]);
      expect((await botState(qa.id)).tasks.filter((task: any) => task.unread)).toEqual([]);
      expect((await botState(qa.id)).threadId).toBe(qa.threadId);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
    } finally {
      stream.close();
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 90_000);

  it("rejects legacy peer starts, inaccessible peers, and oversized batches, and does not duplicate a retried request", async () => {
    const pm = await createBot("Pam", "gated");
    const near = await createBot("Near", "gated");
    const far = await createBot("Far", "gated");
    const other = await createBot("Other", "gated");
    try {
      expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Elsewhere" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${pm.id}`, { peers: [near.id] })).status).toBe(200);
      const token = await heldTurn(pm, "Coordinate only with my allowed teammate.");
      expect((await api("POST", "/api/internal/threads", { toBotId: near.id, title: "Job", message: "go" }, token)).status).toBe(409);
      const send = (botIds: string[]) => api("POST", "/api/internal/coordinate-bots", { botIds, message: "Check it.", requestKey: "scope" }, token);
      const outside = await send([other.id]);
      expect(outside.status).toBe(403);
      expect(outside.body.error).toContain("section boundary");
      const unlisted = await send([far.id]);
      expect(unlisted.status).toBe(403);
      expect(unlisted.body.error).toContain("allowed peer");
      expect((await send([near.id, far.id])).status).toBe(403);
      expect((await send([near.id, far.id, other.id, pm.id, "fifth"])).status).toBe(400);
      for (const bot of [other, far, near]) expect((await botState(bot.id)).tasks).toHaveLength(1);
      const first = await coordinated(token, near.id, "Check it.", "scope");
      const retry = await send([near.id]);
      expect(retry.body.accepted).toEqual([expect.objectContaining({ requestId: first.id, duplicate: true })]);
      expect((await botState(near.id)).tasks).toHaveLength(2);
      expect((await messages(pm.threadId)).filter(message => message.threadRef?.threadId === first.threadId)).toHaveLength(1);
    } finally {
      await cleanup([pm.id, near.id, far.id, other.id]);
    }
  }, 60_000);

  it("waits for the person's approval card and creates no recipient work when denied", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      const originalConversation = await messages(qa.threadId);
      expect((await api("PATCH", `/api/bots/${pm.id}`, { approvePeerComms: true })).status).toBe(200);
      const token = await heldTurn(pm, "Hand it to QA.");
      const pending = api("POST", "/api/internal/coordinate-bots", { botIds: [qa.id], message: "Test it.", requestKey: "approval" }, token);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.card?.tool === "delegate_bot"), { timeout: 15_000 }).toBe(true);
      const card = (await messages(pm.threadId)).find((message) => message.card?.tool === "delegate_bot");
      expect((await botState(qa.id)).tasks).toHaveLength(1);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
      expect((await api("POST", `/api/bots/${pm.id}/respond`, { threadId: pm.threadId, requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      expect(await pending).toMatchObject({ status: 403, body: { error: "Denied by user; no work sent." } });
      expect((await botState(qa.id)).tasks).toHaveLength(1);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id)).busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);

  it("reports a deleted queued destination without falling back to the recipient's own conversation", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      const originalConversation = await messages(qa.threadId);
      // An accepted handoff dispatches at once. Hold Quinn's only thread
      // slot so the destination is still queued when it is deleted.
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
      const hold = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Hold the slot" })).body.task;
      rmSync(join(gates, `${hold.threadId}.gate`), { force: true });
      rmSync(join(gates, `${hold.threadId}.json`), { force: true });
      expect((await api("POST", `/api/bots/${qa.id}/messages`, { text: "Hold the slot.", threadId: hold.threadId })).status).toBe(202);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      const token = await heldTurn(pm, "Hand it to QA.");
      const opened = await coordinated(token, qa.id, "Test it.", "deleted");
      expect((await api("DELETE", `/api/bots/${qa.id}/tasks/${opened.threadId}`)).status).toBe(200);
      release(pm.threadId);
      await expect.poll(() => handoffs().find(node => node.id === opened.id)?.status, { timeout: 15_000 }).toBe("cancelled");
      // The cancelled report resumes Pam; wait for that review turn too.
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      expect((await messages(pm.threadId)).some(message => message.roomRequest?.id === opened.id && message.roomRequest.phase === "result" && message.tool?.ok === false)).toBe(true);
      release(hold.threadId);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(false);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
    } finally {
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 60_000);

  it("still buzzes when a coordinated thread asks the person a question, deep-linked to that thread", async () => {
    const pm = await createBot("Pam", "gated");
    const sage = await createBot("Sage", "curious", "fake-model");
    const stream = await openSse(`${base}/api/events`);
    try {
      const token = await heldTurn(pm, "Ask Sage.");
      const opened = await coordinated(token, sage.id, "Which colour?", "colour");
      release(pm.threadId);
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === sage.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ kind: "question", botId: sage.id, threadId: opened.threadId });
      expect(frame.notification.threadId).not.toBe(sage.threadId);
      const card = (await messages(opened.threadId)).findLast((message) => message.kind === "options" && Boolean(message.card));
      expect(card?.card).toMatchObject({ title: "Your bot has a question" });
    } finally {
      stream.close();
      await cleanup([pm.id, sage.id]);
    }
  }, 60_000);
});

describe("list_threads", () => {
  it("lists your own threads and the ones you opened on a teammate, never a teammate's other threads", async () => {
    const pm = await createBot("Parker", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      // a thread the person opened on Quinn: Quinn's business, not Parker's
      const theirs = await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" });
      expect(theirs.status).toBe(201);
      const token = await heldTurn(pm, "Find the tasks I opened for QA.");
      await coordinated(token, qa.id, "QA: PR #77", "list-thread");
      const mine = await api("GET", "/api/internal/threads", undefined, token);
      expect(mine.status).toBe(200);
      const titles = mine.body.threads.map((row: { title: string; botName: string; own: boolean }) => `${row.own ? "own" : row.botName}:${row.title}`);
      // coordinated work lands in Parker's standing conversation with Quinn,
      // which the sidebar and this list name after the sender, not the brief
      expect(titles).toContain("Quinn:@Parker");
      expect(titles.some((title: string) => title.startsWith("own:"))).toBe(true);
      expect(titles).not.toContain("Quinn:Quinn's own audit");
      // and Quinn, asking for itself, sees its own rows only — never Parker's
      const qaToken = await mintedToken(qa.id, qa.threadId);
      const theirsSeen = await api("GET", "/api/internal/threads", undefined, qaToken);
      expect(theirsSeen.body.threads.every((row: { own: boolean }) => row.own)).toBe(true);
      expect(theirsSeen.body.threads.map((row: { title: string }) => row.title)).toContain("Quinn's own audit");
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  });
});

describe("close_thread", () => {
  it("closes your own thread and one you opened on a teammate, refuses a teammate's other thread and a running one", async () => {
    const pm = await createBot("Parker", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      let token = await heldTurn(pm, "Ask QA to check this, then close its completed task.");
      const close = (threadId: string, headers = token) => api("POST", `/api/internal/threads/${threadId}/close`, {}, headers);
      // a thread the person opened on Quinn is not Parker's to close
      const theirs = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" })).body.task.threadId as string;
      expect((await close(theirs)).status).toBe(403);
      // A queued coordinated thread is active work too, even before the
      // recipient provider starts. It can only be closed after completion.
      const child = await coordinated(token, qa.id, "QA: PR #78", "close-thread");
      const opened = { body: child };
      expect((await close(child.threadId)).status).toBe(409);
      release(child.threadId);
      release(pm.threadId);
      await expect.poll(() => handoffs().find(node => node.id === child.id)?.status, { timeout: 15_000 }).toBe("completed");
      token = await heldTurn(pm, "Close the completed QA task.");
      const closed = await close(opened.body.threadId);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ closed: true, title: "@Parker", botName: "Quinn" });
      expect((await messages(opened.body.threadId)).some((message) => message.tool?.name === "Closed by @Parker")).toBe(true);
      // the close is stamped on the task — that is what the sidebar folds on — and list_threads says closed
      expect((await taskOf(qa.id, opened.body.threadId)).closedBy).toMatchObject({ botId: pm.id, name: "Parker" });
      const listed = (await api("GET", "/api/internal/threads", undefined, token)).body.threads as any[];
      expect(listed.find((row) => row.threadId === opened.body.threadId)).toMatchObject({ state: "closed" });
      // closing again is a quiet no-op: same answer, no second chip
      expect((await close(opened.body.threadId)).body).toMatchObject({ closed: true, alreadyClosed: true });
      expect((await messages(opened.body.threadId)).filter((message) => message.tool?.name === "Closed by @Parker")).toHaveLength(1);
      // Parker's own second thread closes too; the one it speaks in does not
      const own = (await api("POST", `/api/bots/${pm.id}/tasks`, { title: "Notes" })).body.task.threadId as string;
      expect((await close(own)).status).toBe(200);
      expect((await taskOf(pm.id, own)).closedBy).toMatchObject({ name: "Parker" });
      expect((await close(pm.threadId)).status).toBe(400);
      // a new turn in a closed thread reopens it
      rmSync(join(gates, `${own}.gate`), { force: true });
      rmSync(join(gates, `${own}.json`), { force: true });
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "One more thing.", threadId: own })).status).toBe(202);
      await expect.poll(async () => (await taskOf(pm.id, own))?.busy, { timeout: 15_000 }).toBe(true);
      expect(await taskOf(pm.id, own)).not.toHaveProperty("closedBy");
      release(own);
      // a running thread is refused: Quinn, speaking in its own thread, cannot close the one it speaks in,
      // nor a sibling thread of its own while a turn is held open there
      const asQuinn = await mintedToken(qa.id, qa.threadId);
      expect((await close(qa.threadId, asQuinn)).status).toBe(400);
      const busyOther = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Busy one" })).body.task.threadId as string;
      rmSync(join(gates, `${busyOther}.gate`), { force: true });
      rmSync(join(gates, `${busyOther}.json`), { force: true });
      expect((await api("POST", `/api/bots/${qa.id}/messages`, { text: "Work here.", threadId: busyOther })).status).toBe(202);
      await expect.poll(async () => (await taskOf(qa.id, busyOther))?.busy, { timeout: 15_000 }).toBe(true);
      expect((await close(busyOther, asQuinn)).status).toBe(409);
      release(busyOther);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  });
});
