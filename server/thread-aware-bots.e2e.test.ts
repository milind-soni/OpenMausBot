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
  await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
  rmSync(join(gates, `${bot.threadId}.gate`), { force: true });
  rmSync(join(gates, `${bot.threadId}.json`), { force: true });
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text });
  expect(sent.status).toBe(202);
  expect(sent.body.queued).toBeUndefined();
  return liveToken(bot.threadId);
};
/** The opener is woken once with a handoff's outcome; let that turn come
 * and go before holding the thread ourselves. Its gate already exists, so
 * the turn is over in milliseconds — too quick to catch as busy; the
 * fake's reply quoting the wake prompt is the durable evidence. */
const afterWake = async (bot: { id: string; threadId: string }) => {
  await expect.poll(async () => (await messages(bot.threadId)).some(
    // The wake prompt opens with the harness's external-update marker on a
    // thread whose context moved under it (#981), or the older delegated-task
    // opener on one that did not; either is the fake quoting the wake.
    (message) => message.role === "bot" && /reply to: \[(A delegated task|This conversation received an update)/.test(message.text ?? ""),
  ), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
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

describe("start_thread on a teammate", () => {
  it("hands three threads to a peer whose limit is two: two run, one waits in line, all report back", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Hand the pull requests to QA." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const opened: any[] = [];
      for (let index = 1; index <= 3; index++) {
        const response = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: `QA: PR #${index}`, message: `Test pull request ${index}. [[gate:pr-${index}]]`, depth: 0 }, token);
        expect(response.status).toBe(201);
        opened.push(response.body);
      }
      // the forecast: two slots, three handoffs — the third waits in line
      expect(opened[0]).toMatchObject({ botId: qa.id, botName: "Quinn", self: false, state: "pending", limit: 2 });
      expect(opened[1]).toMatchObject({ state: "pending" });
      expect(opened[2]).toMatchObject({ state: "queued", position: 1 });
      expect(opened.every((thread) => typeof thread.delegationId === "string" && thread.delegationId.length > 3)).toBe(true);

      // the person's view of the peer: three rows, opened by Pam under a
      // handoff each, nothing running yet, the selected row untouched
      const before = await botState(qa.id);
      expect(before.threadId).toBe(qa.threadId);
      for (const thread of opened) {
        expect(before.tasks.find((task: any) => task.threadId === thread.threadId)).toMatchObject({
          title: thread.title, busy: false, openedBy: { botId: pm.id, name: "Pam", delegationId: thread.delegationId },
        });
      }
      // and the opener's view: one linkable chip per thread
      const chips = (await messages(pm.threadId)).filter((message) => message.threadRef);
      expect(chips.map((chip) => [chip.tool.name, chip.threadRef.botId, chip.threadRef.threadId])).toEqual(
        opened.map((thread) => [`Opened thread #${thread.title} on Quinn`, qa.id, thread.threadId]),
      );

      // the handoffs start when the opener's turn ends
      release(pm.threadId);
      await expect.poll(async () => (await botState(qa.id)).tasks.filter((task: any) => task.busy).length, { timeout: 15_000 }).toBe(2);
      const busyIds = (await botState(qa.id)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId);
      expect(busyIds.sort()).toEqual([opened[0].threadId, opened[1].threadId].sort());
      expect((await messages(pm.threadId)).some((message) => message.tool?.name === "Thread #QA: PR #3 on @Quinn waiting for a free slot")).toBe(true);
      // the first line of an opened thread is the opener's words, marked as such
      const firstLine = (await messages(opened[0].threadId)).find((message) => message.role === "user");
      expect(firstLine.text).toContain("[Thread opened by @Pam, another bot in this OpenMausBot workspace");
      expect(firstLine.text).toContain("Test pull request 1.");
      expect(firstLine.peerAsk).toMatchObject({ botId: pm.id, name: "Pam" });
      // a peer-opened thread runs one hop down: no agents tools were mounted
      await expect.poll(() => dumpOf("pr-1")?.mcpConfig !== undefined, { timeout: 15_000 }).toBe(true);
      expect(dumpOf("pr-1")!.mcpConfig?.mcpServers?.agents).toBeUndefined();

      // the opener's next turn reads the ledger with its own live token:
      // the handoffs are running, with elapsed time, and nothing has come back
      const readBack = await heldTurn(pm, "How is QA going?");
      // the paragraph that tells a bot what a thread is rides with the tools
      expect(dumpOf(pm.threadId)?.systemPrompt ?? "").toContain("start_thread");
      const running = (await api("GET", `/api/internal/delegations/${opened[0].delegationId}`, undefined, readBack)).body;
      expect(running).toMatchObject({ status: "running", toBotName: "Quinn" });
      expect(running.elapsedMs).toBeGreaterThanOrEqual(0);
      expect((await api("GET", `/api/internal/delegations/${opened[2].delegationId}`, undefined, readBack)).body).toMatchObject({ status: "queued", toBotName: "Quinn" });

      // one slot frees while the other is still working: the line moves
      release("pr-2");
      await expect.poll(async () => (await botState(qa.id)).tasks.some((task: any) => task.threadId === opened[2].threadId && task.busy), { timeout: 15_000 }).toBe(true);
      expect((await taskOf(qa.id, opened[0].threadId)).busy).toBe(true);
      expect((await api("GET", `/api/internal/delegations/${opened[1].delegationId}`, undefined, readBack)).body).toMatchObject({ status: "done" });
      release("pr-1");
      release("pr-3");
      await expect.poll(async () => (await botState(qa.id)).busy, { timeout: 15_000 }).toBe(false);
      for (const thread of opened) {
        const receipt = (await api("GET", `/api/internal/delegations/${thread.delegationId}?wait_ms=15000`, undefined, readBack)).body;
        expect(receipt).toMatchObject({ status: "done", toBotName: "Quinn" });
        expect(receipt.result).toContain("reply to:");
      }
      await expect.poll(async () => (await messages(pm.threadId)).filter((message) => message.text?.startsWith("@Quinn replied to the delegated task")).length, { timeout: 20_000 }).toBe(3);
      // opening and finishing were internal: the peer's rows never badged
      // or bannered the person — its results are the opener's to report
      expect(stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === qa.id)).toEqual([]);
      expect((await botState(qa.id)).tasks.filter((task: any) => task.unread)).toEqual([]);
      // the opener is woken to fold the results in once it is free
      release(pm.threadId);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.text?.includes("[A delegated task just completed]")), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await botState(pm.id)).busy, { timeout: 15_000 }).toBe(false);
    } finally {
      stream.close();
      await cleanup([pm.id, qa.id]);
    }
  }, 90_000);

  it("refuses a peer outside the section, off the allow-list, or one hop too deep, and takes back a fifth handoff's row", async () => {
    const pm = await createBot("Pam", "gated");
    const near = await createBot("Near", "gated");
    const far = await createBot("Far", "gated");
    const other = await createBot("Other", "gated");
    try {
      expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Elsewhere" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${pm.id}`, { peers: [near.id] })).status).toBe(200);
      // minting a capability for a thread retires that thread's previous
      // one, so the one-hop probe goes first
      const deep = await api("POST", "/api/internal/threads", { toBotId: near.id, title: "Job", message: "go" }, await mintedToken(pm.id, pm.threadId, 1));
      expect(deep.status).toBe(200);
      expect(deep.body.error).toContain("one hop");
      const token = await mintedToken(pm.id, pm.threadId);
      const outside = await api("POST", "/api/internal/threads", { toBotId: other.id, title: "Job", message: "go" }, token);
      expect(outside.status).toBe(403);
      expect(outside.body.error).toContain("different section");
      const unlisted = await api("POST", "/api/internal/threads", { toBotId: far.id, title: "Job", message: "go" }, token);
      expect(unlisted.status).toBe(403);
      expect(unlisted.body.error).toContain("not on this bot's allowed peers");
      for (const bot of [other, far, near]) expect((await botState(bot.id)).tasks).toHaveLength(1);
      // the ledger's own ceiling still applies: four handoffs a turn
      for (let index = 0; index < 4; index++) {
        expect((await api("POST", "/api/internal/threads", { toBotId: near.id, title: `Job ${index}`, message: "go" }, token)).status).toBe(201);
      }
      const fifth = await api("POST", "/api/internal/threads", { toBotId: near.id, title: "Job 4", message: "go" }, token);
      expect(fifth.status).toBe(200);
      expect(fifth.body.error).toContain("too many handoffs");
      expect((await botState(near.id)).tasks).toHaveLength(5);
    } finally {
      await cleanup([pm.id, near.id, far.id, other.id]);
    }
  }, 60_000);

  it("waits for the person's card when peer contact needs approval, and reports a denial", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      expect((await api("PATCH", `/api/bots/${pm.id}`, { approvePeerComms: true })).status).toBe(200);
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Hand it to QA." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const opened = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "QA: PR #9", message: "Test it." }, token);
      expect(opened.status).toBe(201);
      expect(opened.body.approvalRequired).toBe(true);
      release(pm.threadId);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.card?.tool === "delegate_bot"), { timeout: 15_000 }).toBe(true);
      const card = (await messages(pm.threadId)).find((message) => message.card?.tool === "delegate_bot");
      // nothing ran on the peer while the card was open
      expect((await taskOf(qa.id, opened.body.threadId)).busy).toBe(false);
      expect((await messages(opened.body.threadId)).some((message) => message.role === "user")).toBe(false);
      expect((await api("POST", `/api/bots/${pm.id}/respond`, { threadId: pm.threadId, requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.tool?.name === "Delegation to @Quinn denied by user"), { timeout: 15_000 }).toBe(true);
      await afterWake(pm);
      const readBack = await heldTurn(pm, "What happened?");
      expect((await api("GET", `/api/internal/delegations/${opened.body.delegationId}`, undefined, readBack)).body).toMatchObject({ status: "denied" });
      expect((await messages(opened.body.threadId)).some((message) => message.role === "user")).toBe(false);
      release(pm.threadId);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);

  it("drops a handoff whose thread was deleted before it could start", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Hand it to QA." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const opened = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "QA: PR #10", message: "Test it." }, token);
      expect(opened.status).toBe(201);
      expect((await api("DELETE", `/api/bots/${qa.id}/tasks/${opened.body.threadId}`)).status).toBe(200);
      release(pm.threadId);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.tool?.name === "Thread on @Quinn canceled — it was deleted before it could start"), { timeout: 15_000 }).toBe(true);
      await afterWake(pm);
      const readBack = await heldTurn(pm, "What happened?");
      expect((await api("GET", `/api/internal/delegations/${opened.body.delegationId}`, undefined, readBack)).body).toMatchObject({ status: "dropped" });
      // the peer's own conversation was never used as a fallback
      expect((await messages(qa.threadId)).some((message) => message.role === "user")).toBe(false);
      release(pm.threadId);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);

  it("still buzzes when a peer-opened thread stops to ask the person a question, deep-linked to that thread", async () => {
    const pm = await createBot("Pam", "gated");
    const sage = await createBot("Sage", "curious", "fake-model");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${pm.id}/messages`, { text: "Ask Sage." })).status).toBe(202);
      const token = await liveToken(pm.threadId);
      const opened = await api("POST", "/api/internal/threads", { toBotId: sage.id, title: "Colour choice", message: "Which colour?" }, token);
      expect(opened.status).toBe(201);
      release(pm.threadId);
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === sage.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ kind: "question", botId: sage.id, threadId: opened.body.threadId });
      expect(frame.notification.threadId).not.toBe(sage.threadId);
      const card = (await messages(opened.body.threadId)).findLast((message) => message.kind === "options" && Boolean(message.card));
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
      const token = await mintedToken(pm.id, pm.threadId);
      const opened = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "QA: PR #77", message: "Test it." }, token);
      expect(opened.status).toBe(201);
      const mine = await api("GET", "/api/internal/threads", undefined, token);
      expect(mine.status).toBe(200);
      const titles = mine.body.threads.map((row: { title: string; botName: string; own: boolean }) => `${row.own ? "own" : row.botName}:${row.title}`);
      expect(titles).toContain("Quinn:QA: PR #77");
      expect(titles.some((title: string) => title.startsWith("own:"))).toBe(true);
      expect(titles).not.toContain("Quinn:Quinn's own audit");
      // and Quinn, asking for itself, sees its own rows only — never Parker's
      const qaToken = await mintedToken(qa.id, qa.threadId);
      const theirsSeen = await api("GET", "/api/internal/threads", undefined, qaToken);
      expect(theirsSeen.body.threads.every((row: { own: boolean }) => row.own)).toBe(true);
      expect(theirsSeen.body.threads.map((row: { title: string }) => row.title)).toContain("Quinn's own audit");
    } finally {
      await api("DELETE", `/api/bots/${pm.id}`);
      await api("DELETE", `/api/bots/${qa.id}`);
    }
  });
});

describe("close_thread", () => {
  it("closes your own thread and one you opened on a teammate, refuses a teammate's other thread and a running one", async () => {
    const pm = await createBot("Parker", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      const token = await mintedToken(pm.id, pm.threadId);
      const close = (threadId: string, headers = token) => api("POST", `/api/internal/threads/${threadId}/close`, {}, headers);
      // a thread the person opened on Quinn is not Parker's to close
      const theirs = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Quinn's own audit" })).body.task.threadId as string;
      expect((await close(theirs)).status).toBe(403);
      // one Parker opened on Quinn is — once it is not running
      const opened = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "QA: PR #78", message: "Test it." }, token);
      expect(opened.status).toBe(201);
      const closed = await close(opened.body.threadId);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ closed: true, title: "QA: PR #78", botName: "Quinn" });
      expect((await messages(opened.body.threadId)).some((message) => message.tool?.name === "Closed by @Parker")).toBe(true);
      // Parker's own second thread closes too; the one it speaks in does not
      const own = (await api("POST", `/api/bots/${pm.id}/tasks`, { title: "Notes" })).body.task.threadId as string;
      expect((await close(own)).status).toBe(200);
      expect((await close(pm.threadId)).status).toBe(400);
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
      await api("DELETE", `/api/bots/${pm.id}`);
      await api("DELETE", `/api/bots/${qa.id}`);
    }
  });
});
