// Queue-and-steer for busy 1:1 bots, at two levels:
//
// Unit: the steer-queue module against a fake store — queue bookkeeping,
// the drain-once property, and the joined single-prompt shape.
//
// e2e: the real harness server with the grokAgent driver on the fake ACP
// CLI in echo-gated mode, whose turns stay open until a gate file exists —
// a deterministic busy window. The echo reply carries the FULL prompt
// (system + turn text), which pins both what a drained turn was sent (the
// queued texts separated by a blank line, in ONE turn) and what it was not (the
// webhook untrusted-data paragraph an attended turn must never get).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  cancelSteeredMessage,
  drainSteeredMessages,
  onSteeredQueueChange,
  queuedSteerSnapshot,
  queuedSteeredMessage,
  queueSteeredMessage,
  _queuedCount,
  type SteerStore,
} from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

// ── unit: the queue module against a fake store ────────────────────────
function fakeBot(id: string, threadId: string, busy: boolean): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  let nextId = 0;
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (threadId, message) => {
      const full: Message = { id: `m${(nextId += 1)}-${threadId}`, at: Date.now(), ...message };
      messages.push(full);
      return full;
    },
    patchMessage: (_threadId, messageId, patch) => {
      const at = messages.findIndex((m) => m.id === messageId);
      if (at === -1) return null;
      messages[at] = { ...messages[at], ...patch };
      return messages[at];
    },
  };
}

describe("steer-queue module", () => {
  it("keeps queue operations and other listeners working when a listener throws", () => {
    const bot = fakeBot("bot-listener-error", "thread-listener-error", false);
    const store = fakeStore([bot]);
    const run = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsubscribeBroken = onSteeredQueueChange(() => { throw new Error("notification failed"); });
    const listener = vi.fn();
    const unsubscribeHealthy = onSteeredQueueChange(listener);
    try {
      const keep = queueSteeredMessage(bot.id, bot.threadId, "still dispatch");
      const cancel = queueSteeredMessage(bot.id, bot.threadId, "cancel me");
      expect(cancelSteeredMessage(bot.id, cancel.id)).toBe(true);
      expect(() => drainSteeredMessages(store, run)).not.toThrow();
      expect(store.messages).toEqual([expect.objectContaining({ text: "still dispatch", queueId: keep.id })]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(_queuedCount(bot.threadId)).toBe(0);
      expect(listener).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribeBroken(); unsubscribeHealthy(); warn.mockRestore();
    }
  });

  it("exports owned public receipts without sharing internal queue state", () => {
    const owned = queueSteeredMessage("bot-public", "thread-public", "public words", {
      prompt: "private provider context", replyToId: "private-reply", sendId: "private-send", reason: "capacity",
    });
    const orphan = queueSteeredMessage("bot-orphan", "thread-orphan", "deleted task");
    try {
      const ownsThread = (botId: string, threadId: string) => botId === "bot-public" && threadId === "thread-public";
      const snapshot = queuedSteerSnapshot(ownsThread);
      expect(snapshot).toEqual({ "thread-public": [{ queueId: owned.id, text: "public words", reason: "capacity" }] });
      snapshot["thread-public"][0].text = "client mutation";
      snapshot["thread-public"].pop();
      expect(queuedSteerSnapshot(ownsThread)["thread-public"]).toEqual([{ queueId: owned.id, text: "public words", reason: "capacity" }]);
    } finally {
      cancelSteeredMessage("bot-public", owned.id);
      cancelSteeredMessage("bot-orphan", orphan.id);
    }
  });

  it("publishes enqueue/cancel/drain snapshots before a failed dispatch can leave stale chips", () => {
    const bot = fakeBot("bot-publish", "thread-publish", true);
    const snapshots: unknown[] = [];
    const unsubscribe = onSteeredQueueChange(() => snapshots.push(queuedSteerSnapshot((id) => id === bot.id)));
    try {
      const first = queueSteeredMessage(bot.id, bot.threadId, "keep");
      const second = queueSteeredMessage(bot.id, bot.threadId, "cancel");
      expect(cancelSteeredMessage("other-bot", second.id)).toBe(false);
      drainSteeredMessages(fakeStore([bot]), vi.fn());
      expect(snapshots).toHaveLength(2);
      expect(cancelSteeredMessage(bot.id, second.id)).toBe(true);
      bot.busy = false;
      expect(() => drainSteeredMessages(fakeStore([bot]), () => { throw new Error("failed dispatch"); })).toThrow("failed dispatch");
      expect(snapshots).toEqual([
        { [bot.threadId]: [{ queueId: first.id, text: "keep" }] },
        { [bot.threadId]: [{ queueId: first.id, text: "keep" }, { queueId: second.id, text: "cancel" }] },
        { [bot.threadId]: [{ queueId: first.id, text: "keep" }] },
        {},
      ]);
    } finally { unsubscribe(); }
    const later = queueSteeredMessage(bot.id, bot.threadId, "unsubscribed");
    cancelSteeredMessage(bot.id, later.id);
    expect(snapshots).toHaveLength(4);
  });

  it("publishes removal when an orphaned queue is discarded", () => {
    queueSteeredMessage("bot-publish-orphan", "thread-publish-orphan", "gone");
    const listener = vi.fn();
    const unsubscribe = onSteeredQueueChange(listener);
    try {
      drainSteeredMessages(fakeStore([]), vi.fn());
      expect(listener).toHaveBeenCalledTimes(1);
      expect(queuedSteerSnapshot(() => true)).toEqual({});
    } finally { unsubscribe(); }
  });

  it("retains an idle task's queue until its runtime dispatch claim clears", () => {
    const bot = fakeBot("bot-handshake", "thread-handshake", false);
    const store = fakeStore([bot]);
    const run = vi.fn();
    const blocked = vi.fn(() => true);
    queueSteeredMessage(bot.id, bot.threadId, "after handshake");
    drainSteeredMessages(store, run, blocked);
    expect(blocked).toHaveBeenCalledWith(bot.id, bot.threadId);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount(bot.threadId)).toBe(1);
    blocked.mockReturnValue(false);
    drainSteeredMessages(store, run, blocked);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.messages.map((message) => message.text)).toEqual(["after handshake"]);
  });

  it("does not append a queued user message until drain", () => {
    const bot = fakeBot("bot-a", "thread-a", true);
    const store = fakeStore([bot]);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "hold that thought");
    expect(queued).toMatchObject({ id: expect.any(String) });
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("thread-a")).toBe(1);

    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      role: "user",
      kind: "text",
      text: "hold that thought",
      queueId: queued.id,
    });
    expect(store.messages[0]!.queued).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(_queuedCount("thread-a")).toBe(0);
  });

  it("keeps a stable client receipt while a send waits to drain", () => {
    const bot = fakeBot("bot-receipt", "thread-receipt", true);
    const store = fakeStore([bot]);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "retry safely", {
      replyToId: "reply-1",
      sendId: "send_1234567890123456",
    });

    expect(queuedSteeredMessage(bot.id, bot.threadId, "send_1234567890123456")).toEqual({
      id: queued.id,
      text: "retry safely",
      replyToId: "reply-1",
    });
    expect(queuedSteeredMessage("other-bot", bot.threadId, "send_1234567890123456")).toBeNull();

    bot.busy = false;
    drainSteeredMessages(store, vi.fn());
    expect(store.messages[0]).toMatchObject({
      text: "retry safely",
      sendId: "send_1234567890123456",
      queueId: queued.id,
    });
    expect(queuedSteeredMessage(bot.id, bot.threadId, "send_1234567890123456")).toBeNull();
  });

  it("holds the queue while the bot is busy and drains it once when idle", () => {
    const bot = fakeBot("bot-b", "thread-b", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "first note");
    const second = queueSteeredMessage(bot.id, bot.threadId, "second note");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("thread-b")).toBe(2);

    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    const [botId, threadId, prompt, userMessage] = run.mock.calls[0];
    expect(botId).toBe("bot-b");
    expect(threadId).toBe("thread-b");
    // ONE turn for the whole burst, with a Markdown block boundary between
    // messages so a trailing attachment tag remains standalone.
    expect(prompt).toBe("first note\n\nsecond note");
    // appended at drain, last message so startTurn adds nothing new
    expect(store.messages.map((m) => m.text)).toEqual(["first note", "second note"]);
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id, second.id]);
    expect(userMessage.text).toBe("second note");
    expect(run.mock.calls[0][4]).toEqual(store.messages.map((m) => m.id));
    expect(store.messages.every((m) => !m.queued)).toBe(true);
    expect(_queuedCount("thread-b")).toBe(0);

    // drain-once: a second settle finds nothing and fires nothing
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops a cancelled message so drain does not send it", () => {
    const bot = fakeBot("bot-cancel", "thread-cancel", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "keep me");
    const second = queueSteeredMessage(bot.id, bot.threadId, "drop me");
    expect(cancelSteeredMessage(bot.id, second.id)).toBe(true);
    expect(cancelSteeredMessage(bot.id, "missing")).toBe(false);
    expect(_queuedCount("thread-cancel")).toBe(1);

    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("keep me");
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id]);
    expect(_queuedCount("thread-cancel")).toBe(0);
  });

  it("keeps reply metadata and the provider-facing reply prompt while queued", () => {
    const bot = fakeBot("bot-reply", "thread-reply", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "That part", {
      replyToId: "original-message",
      prompt: "Reply context\nThat part",
    });
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages[0]).toMatchObject({ text: "That part", replyToId: "original-message" });
    expect(run.mock.calls[0][2]).toBe("Reply context\nThat part");
  });

  it("cancels a pinned-task queue after the bot switches without crossing bot ownership", () => {
    const bot = fakeBot("bot-switch-cancel", "thread-original-cancel", true);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "cancel on the old task");

    bot.threadId = "thread-new-cancel";
    expect(cancelSteeredMessage("some-other-bot", queued.id)).toBe(false);
    expect(cancelSteeredMessage(bot.id, queued.id, bot.threadId)).toBe(false);
    expect(_queuedCount("thread-original-cancel")).toBe(1);
    expect(cancelSteeredMessage(bot.id, queued.id, "thread-original-cancel")).toBe(true);
    expect(_queuedCount("thread-original-cancel")).toBe(0);
  });

  it("fires nothing when nothing is queued", () => {
    const run = vi.fn();
    drainSteeredMessages(fakeStore([fakeBot("bot-c", "thread-c", false)]), run);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops the queue of a deleted bot without running it", () => {
    const bot = fakeBot("bot-d", "thread-d", true);
    queueSteeredMessage(bot.id, bot.threadId, "orphaned");
    const run = vi.fn();
    drainSteeredMessages(fakeStore([]), run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-d")).toBe(0);
  });

  it("drains an idle task B while the same bot's task A stays busy", () => {
    const bot = fakeBot("bot-independent", "thread-independent-a", true);
    const taskA = { ...bot };
    const taskB = { ...bot, threadId: "thread-independent-b", busy: false };
    const store = fakeStore([bot]);
    store.projectBotForTask = (_botId, threadId) => threadId === taskA.threadId ? taskA : taskB;
    queueSteeredMessage(bot.id, taskA.threadId, "wait for A");
    queueSteeredMessage(bot.id, taskB.threadId, "run B");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0].slice(0, 3)).toEqual([bot.id, taskB.threadId, "run B"]);
    expect(_queuedCount(taskA.threadId)).toBe(1);
    expect(_queuedCount(taskB.threadId)).toBe(0);

    taskA.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1].slice(0, 3)).toEqual([bot.id, taskA.threadId, "wait for A"]);
  });

  it("drops a deleted task's queue even when its bot still exists", () => {
    const bot = fakeBot("bot-deleted-task", "thread-deleted-task", false);
    const store = fakeStore([bot]);
    store.projectBotForTask = () => null;
    queueSteeredMessage(bot.id, bot.threadId, "do not resurrect this task");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

});

// ── e2e: the real server on the gated fake ACP fleet ───────────────────
describe("steer-queue e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let drainGate: string;
  let stopGate: string;
  let stopRpcDump: string;
  let earlyGate: string;
  let dispatchGate: string;
  const evidence: unknown[] = [];
  let evidencePath: string;

  /** the flat command payloads these tests POST/PATCH */
  type ApiBody = Record<string, string | boolean | { instanceId: string; model: string }>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = { status: res.status, body: await res.json() };
    if (method !== "GET") evidence.push({ method, path, body, result });
    return result;
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const echoes = (bot: any): any[] =>
    bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("echo: "));

  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const newBot = async (instanceId: string, name: string) => {
    return (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } })).body.bot;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    mkdirSync(join(home, "gates"), { recursive: true });
    drainGate = join(home, "gates", "drain.gate");
    stopGate = join(home, "gates", "stop.gate");
    stopRpcDump = join(home, "gates", "stop.rpc");
    earlyGate = join(home, "gates", "early-provider.gate");
    dispatchGate = join(home, "gates", "early-dispatch.gate");
    evidencePath = join(tmpdir(), `omb-steer-evidence-${Date.now()}-${process.pid}.json`);
    // The CLI and harness remain real. Delay only the adapter's returned
    // acknowledgment, reproducing completion before sendTurn resolves.
    const prelude = join(home, "delayed-dispatch.mjs");
    writeFileSync(prelude, [
      `import { ProviderRegistry } from ${JSON.stringify(pathToFileURL(join(SERVER_DIR, "harness/registry.ts")).href)};`,
      'import { existsSync, writeFileSync } from "node:fs";',
      'const load = ProviderRegistry.prototype.load;',
      'ProviderRegistry.prototype.load = async function(configs) {',
      '  await load.call(this, configs);',
      '  const instance = this.get("steerEarly");',
      '  if (!instance) return;',
      '  const send = instance.adapter.sendTurn;',
      '  instance.adapter.sendTurn = async (turn) => {',
      '    const result = await send(turn);',
      `    writeFileSync(${JSON.stringify(`${dispatchGate}.entered`)}, "entered");`,
      `    while (!existsSync(${JSON.stringify(dispatchGate)})) await new Promise(resolve => setTimeout(resolve, 20));`,
      '    return result;',
      '  };',
      '};',
    ].join("\n"));
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          steer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: drainGate },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          steerEarly: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: earlyGate },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // the RPC dump lets the interrupt test wait for session/prompt to
          // be in flight — interrupting earlier would be a no-op on a turn
          // the driver has not registered yet
          steerStop: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "echo-gated",
              FAKE_ACP_GATE_FILE: stopGate,
              FAKE_ACP_RPC_DUMP: stopRpcDump,
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", pathToFileURL(prelude).href, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    writeFileSync(evidencePath, JSON.stringify({ url: BASE, fixtureHome: home, requests: evidence, stderr }, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    rmSync(home, { recursive: true, force: true });
  });

  it("drains exactly once after completion precedes the dispatch acknowledgment", async () => {
    const bot = await newBot("steerEarly", "Early completion");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first before acknowledgment" })).status).toBe(202);
    await until(async () => existsSync(`${dispatchGate}.entered`), "the pending dispatch acknowledgment");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "queued after acknowledgment" })).body.queued).toBe(true);
    writeFileSync(earlyGate, "complete provider turn");
    await until(async () => echoes(await botById(bot.id)).length === 1, "completion before acknowledgment");
    const pending = await botById(bot.id);
    expect(pending.messages.filter((message: any) => message.role === "user").map((message: any) => message.text))
      .toEqual(["first before acknowledgment"]);
    expect(pending.messages.some((message: any) => message.tool?.name?.includes("queued message could not start"))).toBe(false);
    writeFileSync(dispatchGate, "acknowledge provider dispatch");
    await until(async () => echoes(await botById(bot.id)).length === 2, "the queued turn after acknowledgment");
    const final = await botById(bot.id);
    expect(final.messages.filter((message: any) => message.role === "user").map((message: any) => message.text))
      .toEqual(["first before acknowledgment", "queued after acknowledgment"]);
    expect(echoes(final)[1].text).toContain("queued after acknowledgment");
    expect(final.messages.some((message: any) => message.tool?.name?.includes("queued message could not start"))).toBe(false);
    evidence.push({ earlyCompletionQueue: { pending, final } });
  }, 30_000);

  it(
    "queues sends while busy and drains them into exactly one attended turn",
    async () => {
      const bot = await newBot("steer", "Steerable");

      // the first send starts a turn that stays open until the gate exists
      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "first task please" });
      expect(first.status).toBe(202);
      expect(first.body.queued).toBeUndefined();
      expect((await botById(bot.id)).busy).toBe(true);

      // sends while busy stay off the transcript so they cannot become the leaf
      const second = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer two" });
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({ ok: true, queued: true });
      const third = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer three" });
      expect(third.body.queued).toBe(true);

      let snapshot = await botById(bot.id);
      expect(snapshot.busy).toBe(true);
      expect(snapshot.messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual([
        "first task please",
      ]);
      expect(echoes(snapshot)).toHaveLength(0); // nothing has answered yet

      // open the gate: turn 1 settles, and the queue drains into ONE turn
      writeFileSync(drainGate, "open");
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 2;
      }, "the queued turn");

      const replies = echoes(snapshot);
      // exactly one drained turn for two queued messages — not one each
      expect(replies).toHaveLength(2);
      expect(replies[0].text).toContain("first task please");
      // the drained prompt keeps a Markdown block boundary between messages
      expect(replies[1].text).toContain("steer two\n\nsteer three");
      // ...and it is an ordinary attended turn: no webhook untrusted-data
      // framing, no rewind replay wrapper
      expect(replies[1].text).not.toContain("authenticated external webhook");
      expect(replies[1].text).not.toContain("[The user rewound");
      // drain appends the queued lines after the first turn's reply
      const userTexts = snapshot.messages.filter((m: any) => m.role === "user").map((m: any) => m.text);
      expect(userTexts).toEqual(["first task please", "steer two", "steer three"]);
      expect(snapshot.messages.some((m: any) => m.queued)).toBe(false);

      // an idle send with an empty queue runs one normal turn — the drain
      // adds nothing behind it
      const followUp = await api("POST", `/api/bots/${bot.id}/messages`, { text: "plain follow-up" });
      expect(followUp.body.queued).toBeUndefined();
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 3;
      }, "the follow-up turn");
      expect(echoes(snapshot)).toHaveLength(3);
    },
    60_000,
  );

  it(
    "drains the queue after an interrupt — stop-then-steer",
    async () => {
      const bot = await newBot("steerStop", "Stoppable");

      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "long job" });
      expect(first.status).toBe(202);
      expect((await botById(bot.id)).busy).toBe(true);

      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "after stop please" });
      expect(queued.body.queued).toBe(true);

      // wait for the prompt to be genuinely in flight before stopping it
      await until(async () => {
        try {
          return readFileSync(stopRpcDump, "utf8").includes("session/prompt");
        } catch {
          return false;
        }
      }, "the hung prompt");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);

      // the interrupt settles the hung turn (ACP cancel grace), and the
      // drain consumes the queue: its message loses the queued flag while
      // the steered turn waits on the still-missing gate
      await until(async () => {
        const snapshot = await botById(bot.id);
        const message = snapshot.messages.find((m: any) => m.text === "after stop please");
        return Boolean(message) && !message.queued;
      }, "the post-interrupt drain");

      writeFileSync(stopGate, "open");
      let snapshot: any;
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 1;
      }, "the steered turn");

      // the interrupted turn produced no reply; the steered one answers
      const replies = echoes(snapshot);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toContain("after stop please");
    },
    60_000,
  );
});
