// POSIX-gated like the other CLI e2es: the fakes are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitLaunchNote } from "./testing/launch-note.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("mid-turn steering e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let steerGate: string;
  let steerFinishGate: string;
  let lateSteerFinishGate: string;
  let lateSteerContinuationGate: string;
  let lateSteerDump: string;
  let codexSteerGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const askedAt = (botId: string, threadId: string) => (JSON.parse(readFileSync(join(home, ".openmausbot", "bots.json"), "utf8")) as any[])
    .find((bot) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId).askedAt;
  const PAIRED = { name: "Safari on Mac", id: expect.stringMatching(/^p_[\w-]{22}$/) };
  const asPairedPerson = async () => {
    const opened = await api("POST", "/api/auth/pairing", {});
    expect(opened.status).toBe(200);
    const paired = await fetch(`${BASE}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" },
      body: JSON.stringify({ code: opened.body.code }),
    });
    const session = await paired.json() as any;
    expect(paired.status).toBe(200);
    expect(session.session.label).toBe(PAIRED.name);
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${session.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    steerGate = join(home, "delayed-steer.gate");
    steerFinishGate = join(home, "finish-steered-turn.gate");
    lateSteerFinishGate = join(home, "finish-late-steered-turn.gate");
    lateSteerContinuationGate = join(home, "finish-late-steer-continuation.gate");
    lateSteerDump = join(home, "late-steer-dump.json");
    codexSteerGate = join(home, "codex-steer-refused.gate");
    writeFileSync(codexSteerGate, "refuse live steers until the queue test clears this gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "slow" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeSteer: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: steerFinishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeRace: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_STEER_GATE: steerGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // Results say queued_turn_count: 0 throughout, as Claude 2.1.282's did: words waiting on stdin are not in the queue that field counts.
          claudeLateSteer: {
            driver: "claudeAgent",
            environment: {
              FAKE_CLAUDE_MODE: "slow",
              FAKE_CLAUDE_SLOW_FINISH_GATE: lateSteerFinishGate,
              FAKE_CLAUDE_LATE_STEER_GATE: lateSteerContinuationGate,
              FAKE_CLAUDE_QUEUED_TURN_COUNT: "zero",
              FAKE_CLAUDE_DUMP: lateSteerDump,
            },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // codex parks its turn on an unanswered question; turn/steer folds new input into that live turn without ending it.
          codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1" }, config: { cli: FAKE_CODEX } },
          codexUnknown: {
            driver: "codex",
            environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1", FAKE_CODEX_STEER_HANG: "1", FAKE_CODEX_DUMP: join(home, "unknown-steer.json") },
            config: { cli: FAKE_CODEX },
          },
          codexRace: {
            driver: "codex",
            environment: {
              FAKE_CODEX_MODE: "question",
              FAKE_CODEX_ASK_HOLD: "1",
              FAKE_CODEX_STEER_ERROR_FILE: codexSteerGate,
            },
            config: { cli: FAKE_CODEX },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), FAKE_CODEX_STEER_TIMEOUT_MS: "2000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
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

  it("explicit queue and steer keep their intent, preserve waiting messages, and refuse a stale run", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    const path = `/api/bots/${created.id}/messages/explicit`;
    const queue = { mode: "queue" };
    expect((await api("POST", path, { text: "first explicit run", delivery: queue })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "the explicit run to be ready");
    const runId = (await getBot(created.id)).activeRunId;
    expect(runId).toEqual(expect.any(String));
    const first = await api("POST", path, { text: "waiting one", delivery: queue, sendId: "explicit-queue-first" });
    const second = await api("POST", path, { text: "waiting two", delivery: queue });
    expect(first.body.queued).toBe(true); expect(second.body.queued).toBe(true);
    const person = await asPairedPerson();
    const body = { text: "only this goes into the run", delivery: { mode: "steer", runId }, sendId: "explicit-steer-once" };
    const steered = await person("POST", path, body);
    expect(steered.status).toBe(202); expect(steered.body.steered).toBe(true);
    expect((await person("POST", path, body)).body.message.id).toBe(steered.body.message.id);
    const waiting = (await api("GET", "/api/bots")).body.botQueuedMessages[created.threadId];
    expect(waiting.map((item: any) => item.text)).toEqual(["waiting one", "waiting two"]);
    expect((await getBot(created.id)).messages.filter((m: any) => m.text === body.text)).toHaveLength(1);
    const wrong = await person("POST", path, { text: "must remain a draft", delivery: { mode: "steer", runId: "old-run" } });
    expect(wrong.status).toBe(409); expect(wrong.body.code).toBe("steer_target_changed");
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "must remain a draft")).toBe(false);
    const changedIntent = await api("POST", path, { text: "waiting one", sendId: "explicit-queue-first", delivery: { mode: "steer", runId } });
    expect(changedIntent.status).toBe(409);
    const moved = await api("POST", `/api/bots/${created.id}/queue/${first.body.queueId}/steer`, { threadId: created.threadId });
    expect(moved.body.steered).toBe(true);
    const replay = await api("POST", path, { text: "waiting one", sendId: "explicit-queue-first", delivery: queue });
    expect(replay.status).toBe(202);
    expect(replay.body.message.composerDelivery).toEqual(queue);
    expect((await api("POST", path, { text: "waiting one", sendId: "explicit-queue-first", delivery: { mode: "steer", runId } })).status).toBe(409);
    await api("DELETE", `/api/bots/${created.id}/queue/${second.body.queueId}`, { threadId: created.threadId });
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => !(await getBot(created.id)).busy, "the explicit run to finish");
    const ended = await person("POST", path, { text: "do not start a replacement", delivery: { mode: "steer", runId } });
    expect(ended.status).toBe(409);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "do not start a replacement")).toBe(false);
  }, 40_000);

  it("an uncertain explicit steer retains its receipt and never writes again on retry", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codexUnknown").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexUnknown", model } });
    const path = `/api/bots/${created.id}/messages/explicit`;
    await api("POST", path, { text: "hold unknown run", delivery: { mode: "queue" } });
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "unknown run ready");
    const runId = (await getBot(created.id)).activeRunId;
    const body = { text: "possibly delivered", sendId: "uncertain-steer-id", delivery: { mode: "steer", runId } };
    const first = await api("POST", path, body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ ok: false, uncertain: true, message: { steerUncertain: true, composerDelivery: body.delivery } });
    expect(first.body.steered).toBeUndefined();
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => !(await getBot(created.id)).busy, "unknown run stopped");
    const replay = await api("POST", path, body);
    expect(replay.body).toEqual(first.body);
    const dump = JSON.parse(readFileSync(join(home, "unknown-steer.json"), "utf8"));
    expect(dump.calls.filter((call: any) => call.method === "turn/steer")).toHaveLength(1);
    expect((await api("GET", "/api/bots")).body.botQueuedMessages[created.threadId] ?? []).toEqual([]);
  }, 40_000);

  it("a delayed explicit receipt stays attributed to its original run after the queue starts another", async () => {
    rmSync(steerGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeRace", model: "claude-fake" } });
    const path = `/api/bots/${created.id}/messages/explicit`;
    await api("POST", path, { text: "race run A", delivery: { mode: "queue" } });
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "run A tool chip");
    const original = await getBot(created.id);
    const runId = original.activeRunId;
    const anchor = original.messages.at(-1).id;
    await api("POST", path, { text: "race run B", delivery: { mode: "queue" } });
    const pending = api("POST", path, { text: `late A receipt ${"x".repeat(900_000)}`, sendId: "late-explicit-receipt", delivery: { mode: "steer", runId } });
    try {
      await waitFor(async () => { const bot = await getBot(created.id); return Boolean(bot.activeRunId && bot.activeRunId !== runId); }, "queued run B to start");
      const before = askedAt(created.id, created.threadId);
      writeFileSync(steerGate, "release pending write");
      const result = await pending;
      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({ ok: false, uncertain: true, message: { steerUncertain: true } });
      expect(result.body.steered).toBeUndefined();
      expect(result.body.message).toMatchObject({ parentId: anchor, composerDelivery: { mode: "steer", runId } });
      expect(askedAt(created.id, created.threadId)).toBe(before);
      const bot = await getBot(created.id);
      const next = bot.messages.find((m: any) => m.text === "race run B");
      expect(next).toBeDefined();
      expect(next.parentId).not.toBe(anchor);
      expect((await api("POST", path, { text: result.body.message.text, sendId: "late-explicit-receipt", delivery: { mode: "steer", runId } })).body.message.id).toBe(result.body.message.id);
    } finally {
      writeFileSync(steerGate, "cleanup");
      await pending;
      await api("POST", `/api/bots/${created.id}/interrupt`);
      await waitFor(async () => !(await getBot(created.id)).busy, "race cleanup");
    }
  }, 40_000);

  it("an indeterminate queued steer remains uncertain on explicit-send retry without replay", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codexUnknown").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexUnknown", model } });
    const path = `/api/bots/${created.id}/messages/explicit`;
    await api("POST", path, { text: "hold queued uncertain run", delivery: { mode: "queue" } });
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "queued uncertain run ready");
    const body = { text: "possibly received from queue", sendId: "uncertain-queued-steer", delivery: { mode: "queue" } };
    const queued = await api("POST", path, body);
    expect(queued.body.queued).toBe(true);
    const moved = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId });
    expect(moved.body).toMatchObject({ ok: false, uncertain: true, queueIds: [queued.body.queueId],
      messages: [expect.objectContaining({ steerUncertain: true, composerDelivery: body.delivery })] });
    expect(moved.body.steered).toBeUndefined();
    const replay = await api("POST", path, body);
    expect(replay.body).toMatchObject({ ok: false, uncertain: true, message: { id: moved.body.messages[0].id } });
    expect((await api("GET", "/api/bots")).body.botQueuedMessages[created.threadId] ?? []).toEqual([]);
    const dump = JSON.parse(readFileSync(join(home, "unknown-steer.json"), "utf8"));
    expect(dump.calls.filter((call: any) => call.method === "turn/steer")).toHaveLength(1);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => !(await getBot(created.id)).busy, "queued uncertain run stopped");
  }, 40_000);

  it("an explicit steer refusal never falls back to the queue, and malformed intent is rejected", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    const path = `/api/bots/${created.id}/messages/explicit`;
    for (const delivery of [undefined, { mode: "steer" }, { mode: "queue", runId: "extra" }, { mode: "other" }]) {
      expect((await api("POST", path, { text: "not sent", delivery })).status).toBe(400);
    }
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "not sent", delivery: { mode: "queue" } })).status).toBe(400);
    await api("POST", path, { text: "held initial run", delivery: { mode: "queue" } });
    await waitFor(async () => Boolean((await getBot(created.id)).activeRunId), "the unsupported run to start");
    const runId = (await getBot(created.id)).activeRunId;
    const refused = await api("POST", path, { text: "must not queue", delivery: { mode: "steer", runId } });
    expect(refused.status).toBe(409); expect(refused.body.code).toBe("steer_refused");
    expect((await api("GET", "/api/bots")).body.botQueuedMessages[created.threadId] ?? []).toEqual([]);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => !(await getBot(created.id)).busy, "the unsupported run to finish");
  }, 40_000);

  it(
    "a message during a Claude turn is steered into it: 202, in the transcript in order and marked, folded into the reply",
    async () => {
      rmSync(steerFinishGate, { force: true });
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((i: any) => i.instanceId === "claudeSteer").capabilities.queueing).toBe(true);

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
      // the fake pauses after its tool result; this lands inside that gap
      await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
      let second: Awaited<ReturnType<typeof api>>;
      try {
        second = await api("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
      } finally {
        writeFileSync(steerFinishGate, "finish");
      }
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);

      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      const bot = await getBot(created.id);
      const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.role === "bot" ? withoutTurnClock(m.text) : m.text}`);
      expect(texts.slice(1)).toEqual([
        "user:first",
        "bot:hello from fake claude",
        "user:and also this",
        "bot:reply to: first + steered: and also this",
      ]);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      expect(askedAt(created.id, created.threadId)).toBe(steered.at);
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
      const chip = bot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Bash");
      expect(chip.tool).toMatchObject({ ok: true, summary: "echo hi" });
    },
    40_000,
  );

  it("a steer the CLI runs as its next native turn keeps the turn, its busy state and its internal tool pass until that reply lands", async () => {
    rmSync(lateSteerFinishGate, { force: true });
    rmSync(lateSteerContinuationGate, { force: true });
    rmSync(lateSteerDump, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeLateSteer", model: "claude-fake" } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
    let dump: any;
    await waitFor(async () => {
      try {
        dump = JSON.parse(readFileSync(lateSteerDump, "utf8"));
        return true;
      } catch {
        return false;
      }
    }, "the fake's spawn dump");
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    const internalTools = async () =>
      (await fetch(`${BASE}/api/internal/agents`, { headers: { authorization: `Bearer ${token}` } })).status;
    expect(await internalTools()).toBe(200);

    const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
    expect(second.status).toBe(202);
    expect(second.body.steered).toBe(true);
    writeFileSync(lateSteerFinishGate, "finish");
    await waitFor(
      async () => (await getBot(created.id)).messages.filter((m: any) => m.kind === "activity").length === 2,
      "the continuation's tool chip",
    );
    expect((await getBot(created.id)).busy).toBe(true);
    expect(await internalTools()).toBe(200);

    writeFileSync(lateSteerContinuationGate, "finish");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
    expect(await internalTools()).toBe(401);
    const bot = await getBot(created.id);
    const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.role === "bot" ? withoutTurnClock(m.text) : m.text}`);
    expect(texts.slice(1)).toEqual([
      "user:first",
      "bot:hello from fake claude",
      "user:and also this",
      "bot:reply to: first",
      "bot:hello from fake claude",
      "bot:reply to: and also this",
    ]);
    const events = readFileSync(join(home, ".openmausbot", "events", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1);
    const answered = events.findIndex((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "reply to: and also this");
    expect(answered).toBeGreaterThan(-1);
    expect(events.indexOf(completed[0])).toBeGreaterThan(answered);
  }, 40_000);

  it("keeps two queued attachment messages as two native images in one follow-up turn", async () => {
    // The opener holds the bot's one slot on the gated slow instance, so both sends queue; a timed opener could settle between them.
    rmSync(steerFinishGate, { force: true });
    const previousLimit = (await api("GET", "/api/config")).body.threads.maxConcurrentPerBot as number;
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    try {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "claudeSteer", model: "claude-fake" },
      });
      const waiting = (await api("POST", `/api/bots/${created.id}/tasks`, { title: "Images" })).body.task.threadId as string;
      const waitingMessages = async () =>
        (await api("GET", `/api/threads/${waiting}/messages?limit=20`)).body.messages as any[];
      expect((await api("POST", `/api/bots/${created.id}/messages`, { threadId: created.threadId, text: "first image task" })).status)
        .toBe(202);
      const openerMessages = async () =>
        (await api("GET", `/api/threads/${created.threadId}/messages?limit=20`)).body.messages as any[];
      await waitFor(
        async () => (await openerMessages()).some((message: any) => message.kind === "activity"),
        "the image queue tool chip",
      );

      const attachments = join(home, ".openmausbot", "attachments");
      mkdirSync(attachments, { recursive: true });
      const firstImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174000.png");
      const secondImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174001.png");
      writeFileSync(firstImagePath, "first png");
      writeFileSync(secondImagePath, "second png");
      const firstAttachedText = `look at this\n\n<attached-image path="${firstImagePath}" name="first.png" />`;
      const secondAttachedText = `and this\n\n<attached-image path="${secondImagePath}" name="second.png" />`;
      try {
        const firstReceipt = await api("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: firstAttachedText });
        const secondReceipt = await api("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: secondAttachedText });

        expect(firstReceipt.status).toBe(202);
        expect(firstReceipt.body).toMatchObject({ ok: true, queued: true, reason: "capacity" });
        expect(firstReceipt.body.steered).toBeUndefined();
        expect(secondReceipt.status).toBe(202);
        expect(secondReceipt.body).toMatchObject({ ok: true, queued: true, reason: "capacity" });
        expect(secondReceipt.body.steered).toBeUndefined();
        expect(
          (await waitingMessages()).some(
            (message: any) => message.text === firstAttachedText || message.text === secondAttachedText,
          ),
        ).toBe(false);
      } finally {
        writeFileSync(steerFinishGate, "finish");
      }

      await waitFor(
        async () => {
          const messages = await waitingMessages();
          return [firstAttachedText, secondAttachedText].every((text) =>
            messages.some((message: any) => message.text === text),
          );
        },
        "both attached messages to drain",
      );
      await waitFor(
        async () => (await getBot(created.id)).tasks.every((task: any) => !task.busy),
        "the attached follow-up to settle",
      );

      const nativeRows = readFileSync(
        join(home, ".openmausbot", "native", `${waiting}.ndjson`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      // A new session's first message also carries the volatile half of the bot's instructions: read it as the prompt.
      const followUp = splitLaunchNote(nativeRows
        .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
        .at(-1)?.msg).prompt;
      expect(followUp.message.content.map((block: any) => block.type === "text" ? { ...block, text: withoutTurnClock(block.text) } : block)).toEqual([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "[image data: 16 base64 chars]" },
        },
        { type: "text", text: "look at this\n\n\n\nand this\n\n" },
      ]);
    } finally {
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: previousLimit } });
    }
  }, 40_000);

  it("an attachment sent during a Claude turn is steered into it as native images", async () => {
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174006.png");
    writeFileSync(imagePath, "steered png");
    const imageText = `and look at this\n\n<attached-image path="${imagePath}" name="shot.png" />`;
    let second: Awaited<ReturnType<typeof api>>;
    try {
      second = await api("POST", `/api/bots/${created.id}/messages`, { text: imageText });
    } finally {
      writeFileSync(steerFinishGate, "finish");
    }
    expect(second.status).toBe(202);
    expect(second.body.steered).toBe(true);

    await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
    const bot = await getBot(created.id);
    const steered = bot.messages.find((m: any) => m.text === imageText);
    expect(steered.steered).toBe(true);
    const replies = bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"));
    expect(replies).toHaveLength(1);
    expect(withoutTurnClock(replies[0].text)).toBe("reply to: first + steered: [image] and look at this");

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.filter((row) =>
      row.dir === "out" && row.source === "claude.sdk.message" && Array.isArray(row.msg?.message?.content),
    ).at(-1)?.msg;
    expect(steerRow.uuid).toEqual(expect.any(String));
    expect(steerRow.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 16 base64 chars]" } },
      { type: "text", text: "and look at this\n\n" },
    ]);
  }, 40_000);

  it("delivers a queued room burst's non-last image natively in the coalesced turn", async () => {
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeSteer", model: "claude-fake" },
    });
    const room = (await api("POST", "/api/groups", {
      name: "Burst image room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the room" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");

    // Loopback API sends never merge (each is its own identity), so the burst comes from one paired person; the gated opener cannot settle early.
    const person = await asPairedPerson();
    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174004.png");
    writeFileSync(imagePath, "room png");
    const imageText = `look at the room screenshot\n\n<attached-image path="${imagePath}" name="shot.png" />`;
    const firstReceipt = await person("POST", `/api/groups/${room.id}/messages`, { text: imageText });
    expect((await getGroup())?.working).toBe(true);
    const secondReceipt = await person("POST", `/api/groups/${room.id}/messages`, { text: "and summarize it" });
    writeFileSync(steerFinishGate, "finish");
    expect(firstReceipt.status).toBe(202);
    expect(firstReceipt.body).toMatchObject({ ok: true, queued: true });
    expect(secondReceipt.status).toBe(202);
    expect(secondReceipt.body).toMatchObject({ ok: true, queued: true });

    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === "and summarize it"),
      "the coalesced burst to drain",
    );
    await waitFor(async () => (await getGroup())?.working === false, "the burst turn to settle");
    expect(
      (await getGroup())?.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("reply to:")),
    ).toHaveLength(2);

    const nativeRows = readFileSync(
      join(home, ".openmausbot", "native", `${room.threadId}.ndjson`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const followUp = nativeRows
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .at(-1)?.msg;
    expect(followUp.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" } },
      expect.objectContaining({ type: "text" }),
    ]);
    const textBlock = followUp.message.content.find((block: any) => block.type === "text").text;
    expect(textBlock).toContain("look at the room screenshot");
    expect(textBlock).toContain("and summarize it");
    expect(textBlock).not.toContain("<attached-image");
  }, 40_000);

  it("rejects a delayed steer acknowledgement after the bot is deleted", async () => {
    rmSync(steerGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeRace", model: "claude-fake" },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first race turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the race turn to start");
    await waitFor(
      async () => (await getBot(created.id))?.messages.some((message: any) => message.kind === "activity"),
      "the race turn tool chip",
    );

    // The fake paused stdin after the first prompt; this exceeds a pipe's buffer, so the steer cannot acknowledge until the gate opens.
    const delayed = api("POST", `/api/bots/${created.id}/messages`, {
      text: `delayed ownership check ${"x".repeat(900_000)}`,
      threadId: created.threadId,
    });
    const prematurelySettled = await Promise.race([
      delayed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(prematurelySettled).toBe(false);

    await waitFor(async () => (await getBot(created.id))?.busy === false, "the original race turn to settle");
    expect((await api("DELETE", `/api/bots/${created.id}`)).status).toBe(200);
    writeFileSync(steerGate, "open");

    const rejected = await delayed;
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toMatch(/no such bot/i);
  }, 40_000);

  it("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect(typeof queued.body.queueId).toBe("string");
    expect(queued.body.threadId).toBe(created.threadId);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    const drained = (await getBot(created.id)).messages.find((m: any) => m.text === "second");
    expect(drained.queueId).toBe(queued.body.queueId);
    expect(drained.sender).toEqual(PAIRED);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 30_000);

  it("a message waiting for a free slot still names the paired person once it runs", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    const limit = (await api("GET", "/api/config")).body.threads.maxConcurrentPerBot as number;
    const threads: string[] = [created.threadId];
    for (let i = 0; i < limit; i++) {
      threads.push((await api("POST", `/api/bots/${created.id}/tasks`, { title: `Slot ${i + 2}` })).body.task.threadId);
    }
    const waiting = threads.at(-1)!;
    const busy = async () =>
      (await getBot(created.id)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId) as string[];
    try {
      for (const threadId of threads.slice(0, limit)) {
        expect((await api("POST", `/api/bots/${created.id}/messages`, { threadId, text: "hold a slot" })).status).toBe(202);
      }
      await waitFor(async () => (await busy()).length === limit, "every slot to be taken");

      const person = await asPairedPerson();
      const queued = await person("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: "when a slot frees up" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ queued: true, reason: "capacity", threadId: waiting });

      await api("POST", `/api/bots/${created.id}/interrupt`, { threadId: threads[0] });
      const line = async () =>
        (await api("GET", `/api/threads/${waiting}/messages?limit=20`)).body.messages.find((m: any) => m.text === "when a slot frees up");
      await waitFor(async () => Boolean(await line()), "the waiting message to start its turn");
      expect((await line()).sender).toEqual(PAIRED);
    } finally {
      for (const threadId of threads) await api("POST", `/api/bots/${created.id}/interrupt`, { threadId });
      await waitFor(async () => (await busy()).length === 0, "every slot to settle");
    }
  }, 40_000);

  it("a codex message during a live turn is steered into it via turn/steer, and Stop never reports SIGTERM", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const codexInstance = instances.find((i: any) => i.instanceId === "codex");
    expect(codexInstance.capabilities.queueing).toBe(true);
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "codex", model: codexInstance.models.default },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first codex turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the codex turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.card),
      "the codex question card",
    );

    const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
    expect(second.status).toBe(202);
    expect(second.body.steered).toBe(true);
    const steered = (await getBot(created.id)).messages.find((m: any) => m.text === "and also this");
    expect(steered.steered).toBe(true);

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    expect(steerRow?.params).toMatchObject({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "and also this" }],
      expectedTurnId: "turn-1",
    });

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the steered codex turn to settle");
    const bot = await getBot(created.id);
    expect(JSON.stringify(bot.messages)).not.toContain("SIGTERM");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it("the queue steer endpoint pulls a codex queue into the running turn once the engine can steer", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codexRace").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexRace", model } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first gated turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the gated turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.card),
      "the gated question card",
    );

    // the gate file makes the live steer lose: the words queue instead
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/bots/${created.id}/messages`, { text: "steer these queued words" });
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "steer these queued words")).toBe(false);

    rmSync(codexSteerGate, { force: true });
    const steered = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body.steered).toBe(true);
    expect(steered.body.queueIds).toEqual([queued.body.queueId]);
    const folded = (await getBot(created.id)).messages.find((m: any) => m.text === "steer these queued words");
    expect(folded.steered).toBe(true);
    expect(folded.sender).toEqual(PAIRED);
    expect(steered.body.messages[0].sender).toEqual(PAIRED);
    expect(askedAt(created.id, created.threadId)).toBe(folded.at);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queue-steered turn to settle");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it("an engine without live steering keeps its queue through the steer endpoint, then drains after Stop", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.body.queued).toBe(true);

    const still = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).busy).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the preserved queue to drain",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle");
  }, 40_000);

  it("a room steer folds the queued head into the running codex turn, and room Stop reports no SIGTERM", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    const room = (await api("POST", "/api/groups", {
      name: "Steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
    await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.card), "the room question card");

    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: "steer these room words" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect((await getGroup())?.messages.some((m: any) => m.text === "steer these room words")).toBe(false);

    const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, steered: true });
    expect(steered.body.queueIds).toEqual([queued.body.queueId]);
    const folded = (await getGroup())?.messages.find((m: any) => m.text === "steer these room words");
    expect(folded?.steered).toBe(true);
    expect(folded?.sender).toEqual(PAIRED);

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${room.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    expect(steerRow?.params).toMatchObject({ input: [{ type: "text", text: "steer these room words" }] });

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the steered room turn to settle");
    expect(JSON.stringify((await getGroup())?.messages)).not.toContain("SIGTERM");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it("a room whose engine cannot steer keeps its queue, then drains after Stop", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    const room = (await api("POST", "/api/groups", {
      name: "Queue room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the hung room turn to start");
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const still = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getGroup())?.working).toBe(true);
    expect((await getGroup())?.messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === "second"),
      "the preserved room queue to drain",
    );
    expect((await getGroup())?.messages.find((m: any) => m.text === "second")?.sender).toEqual(PAIRED);
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the drained room turn to settle");
  }, 40_000);

  it("a room steer keeps each burst line's own reply context in the fold", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    const room = (await api("POST", "/api/groups", {
      name: "Reply burst room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
    await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.card), "the room question card");
    const firstTurnId = (await getGroup())?.messages.find(
      (m: any) => m.role === "user" && m.text === "first room turn",
    )?.id;
    expect(firstTurnId).toBeTruthy();

    const person = await asPairedPerson();
    const replying = await person("POST", `/api/groups/${room.id}/messages`, {
      text: "steer this reply line",
      replyToId: firstTurnId,
    });
    const plain = await person("POST", `/api/groups/${room.id}/messages`, { text: "and this plain line" });
    expect(replying.body).toMatchObject({ ok: true, queued: true });
    expect(plain.body).toMatchObject({ ok: true, queued: true });

    const steered = await api("POST", `/api/groups/${room.id}/queue/${replying.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body.steered).toBe(true);
    expect(steered.body.queueIds).toEqual([replying.body.queueId, plain.body.queueId]);

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${room.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const foldRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    const foldedText = foldRow?.params.input.map((block: any) => block.text).join("\n") ?? "";
    expect(foldedText).toContain("steer this reply line");
    expect(foldedText).toContain("and this plain line");
    expect(foldedText.match(/The current message is a reply to/g)).toHaveLength(1);
    expect(foldedText).toContain("first room turn");

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the steered room turn to settle");
  }, 40_000);

  it("a queued room attachment refuses the fold and waits for a real turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    const room = (await api("POST", "/api/groups", {
      name: "Attachment steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
    await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.card), "the room question card");

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174005.png");
    writeFileSync(imagePath, "clip png");
    const imageText = `look at the clip\n\n<attached-image path="${imagePath}" name="clip.png" />`;

    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: imageText });
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, queued: true, blockedBy: "images" });
    expect(steered.body.steered).toBeUndefined();
    expect((await getGroup())?.working).toBe(true);
    expect((await getGroup())?.messages.some((m: any) => m.text === imageText)).toBe(false);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === imageText),
      "the attachment line to drain",
    );
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the drained attachment turn to settle");

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${room.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(nativeRows.filter((row) => row.dir === "out" && row.msg?.method === "turn/steer")).toHaveLength(0);
  }, 40_000);

  it("a room steer folds a queued attachment into the running Claude turn as native images", async () => {
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
    const room = (await api("POST", "/api/groups", {
      name: "Image steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    try {
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the room" })).status).toBe(202);
      await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
      await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.kind === "activity"), "the room tool chip");

      const attachments = join(home, ".openmausbot", "attachments");
      mkdirSync(attachments, { recursive: true });
      const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174007.png");
      writeFileSync(imagePath, "room steer png");
      const imageText = `what about this one\n\n<attached-image path="${imagePath}" name="room.png" />`;
      const person = await asPairedPerson();
      const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: imageText });
      expect(queued.body).toMatchObject({ ok: true, queued: true });

      const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
        threadId: room.threadId,
      });
      expect(steered.status).toBe(200);
      expect(steered.body).toMatchObject({ ok: true, steered: true });
      expect(steered.body.queueIds).toEqual([queued.body.queueId]);
      expect(steered.body.blockedBy).toBeUndefined();
      const folded = (await getGroup())?.messages.find((m: any) => m.text === imageText);
      expect(folded?.steered).toBe(true);
      expect(folded?.sender).toEqual(PAIRED);
    } finally {
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getGroup())?.working === false, "the steered room turn to settle");
    const replies = (await getGroup())?.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("reply to:"));
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain("+ steered: [image] what about this one");

    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${room.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.filter((row) =>
      row.dir === "out" && row.source === "claude.sdk.message" && Array.isArray(row.msg?.message?.content),
    ).at(-1)?.msg;
    expect(steerRow.uuid).toEqual(expect.any(String));
    expect(steerRow.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 20 base64 chars]" } },
      { type: "text", text: "what about this one\n\n" },
    ]);
  }, 40_000);

  it("the queue steer endpoint keeps a codex attachment queued and says why", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const codexInstance = instances.find((i: any) => i.instanceId === "codex");
    expect(codexInstance.capabilities.queueing).toBe(true);
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model: codexInstance.models.default } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first codex turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the codex turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "the codex question card");

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174008.png");
    writeFileSync(imagePath, "codex png");
    const imageText = `see this\n\n<attached-image path="${imagePath}" name="codex.png" />`;
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: imageText });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const still = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true, blockedBy: "images" });
    expect(still.body.steered).toBeUndefined();
    expect((await getBot(created.id)).busy).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === imageText)).toBe(false);
    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(nativeRows.filter((row) => row.dir === "out" && row.msg?.method === "turn/steer")).toHaveLength(0);

    expect((await api("DELETE", `/api/bots/${created.id}/queue/${queued.body.queueId}`, { threadId: created.threadId })).status).toBe(200);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the codex turn to settle");
  }, 40_000);
});
