// Queue-and-steer for busy 1:1 bots, at two levels:
//
// Unit: the steer-queue module against a fake store — queue bookkeeping,
// the drain-once property, and the joined single-prompt shape.
//
// e2e: the real harness server with the grokAgent driver on the fake ACP
// CLI in echo-gated mode, whose turns stay open until a gate file exists —
// a deterministic busy window. The echo reply carries the FULL prompt
// (system + turn text), which pins both what a drained turn was sent (the
// queued texts joined with newlines, in ONE turn) and what it was not (the
// webhook untrusted-data paragraph an attended turn must never get).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cancelSteeredMessage, drainSteeredMessages, queueSteeredMessage, _queuedCount, type SteerStore } from "./steer-queue.ts";
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
  it("does not append a queued user message until drain", () => {
    const bot = fakeBot("bot-a", "thread-a", true);
    const store = fakeStore([bot]);
    const queued = queueSteeredMessage(bot, "hold that thought");
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

  it("holds the queue while the bot is busy and drains it once when idle", () => {
    const bot = fakeBot("bot-b", "thread-b", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot, "first note");
    const second = queueSteeredMessage(bot, "second note");
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
    // ONE turn for the whole burst: the texts joined with newlines
    expect(prompt).toBe("first note\nsecond note");
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
    const first = queueSteeredMessage(bot, "keep me");
    const second = queueSteeredMessage(bot, "drop me");
    expect(cancelSteeredMessage("thread-cancel", second.id)).toBe(true);
    expect(cancelSteeredMessage("thread-cancel", "missing")).toBe(false);
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
    queueSteeredMessage(bot, "That part", {
      replyToId: "original-message",
      prompt: "Reply context\nThat part",
    });
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages[0]).toMatchObject({ text: "That part", replyToId: "original-message" });
    expect(run.mock.calls[0][2]).toBe("Reply context\nThat part");
  });

  it("fires nothing when nothing is queued", () => {
    const run = vi.fn();
    drainSteeredMessages(fakeStore([fakeBot("bot-c", "thread-c", false)]), run);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops the queue of a deleted bot without running it", () => {
    const bot = fakeBot("bot-d", "thread-d", true);
    queueSteeredMessage(bot, "orphaned");
    const run = vi.fn();
    drainSteeredMessages(fakeStore([]), run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-d")).toBe(0);
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

  /** the flat command payloads these tests POST/PATCH */
  type ApiBody = Record<string, string | boolean | { instanceId: string; model: string }>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
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
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    mkdirSync(join(home, "gates"), { recursive: true });
    drainGate = join(home, "gates", "drain.gate");
    stopGate = join(home, "gates", "stop.gate");
    stopRpcDump = join(home, "gates", "stop.rpc");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          steer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: drainGate },
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
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
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
    rmSync(home, { recursive: true, force: true });
  });

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
      // the drained prompt is the queued texts joined with newlines
      expect(replies[1].text).toContain("steer two\nsteer three");
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
