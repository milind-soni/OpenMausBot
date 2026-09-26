// Mid-turn steering, end to end: boots the real harness with the fake claude
// CLI in `slow` mode (a gap after the tool result the way a real turn has
// between model calls), sends a message WHILE the turn runs, and asserts
// it is taken into the turn — 202 steered; in the transcript in order and
// marked; folded into the reply — while an engine without a live session
// falls back to the server-side queue.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  let codexSteerGate: string;
  // The admission chooser's fake decision model: a keyless custom-lane
  // endpoint on this machine. It answers the boot-time calibration canary
  // deterministically, then serves whatever admission outcome the test
  // below has staged — including a slow one, to exercise the abort budget.
  let decisionServer: ReturnType<typeof createServer>;
  let admissionOutcome: { choice: "steer" | "queue" | "abstain"; confidence: number; delayMs?: number } = { choice: "abstain", confidence: 0.99 };
  let admissionCalls = 0;
  const resetAdmissionOutcome = () => {
    admissionOutcome = { choice: "abstain", confidence: 0.99 };
  };
  /** Probabilities over the admission candidates that sum to exactly one:
  * validateChoice checks the sum, and drifting floats would flake. */
  const admissionAnswer = () => {
    const probabilities: Record<string, number> = { steer: 0, queue: 0, abstain: 0 };
    probabilities[admissionOutcome.choice] = admissionOutcome.confidence;
    const others = (["steer", "queue", "abstain"] as const).filter((id) => id !== admissionOutcome.choice);
    const rest = Math.round(((1 - admissionOutcome.confidence) / 2) * 1e6) / 1e6;
    probabilities[others[0]] = rest;
    probabilities[others[1]] = Math.round((1 - admissionOutcome.confidence - rest) * 1e6) / 1e6;
    return { choice: admissionOutcome.choice, confidence: admissionOutcome.confidence, probabilities };
  };

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  /** Pair a second device the way a teammate does, and send as them. A
   * queue is a delay, never a change of author: their words must still be
   * theirs when they finally reach the transcript. */
  // `id` is the opaque person key the server derives from the session.
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

  /** Tap the runtime stream the way an app window does and keep only
  * admission decisions. Open it before the send that should publish. */
  const admissionStream = async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    const wire = res.body;
    if (!res.ok || !wire) throw new Error(`event stream opened ${res.status}`);
    const events: any[] = [];
    let buffer = "";
    void (async () => {
      const reader = wire.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          for (const line of buffer.slice(0, split).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const frame = JSON.parse(line.slice(6)) as { kind?: string; event?: { type?: string } };
              if (frame.kind === "runtime" && frame.event?.type === "decision.admission") events.push(frame.event);
            } catch {
              /* a non-JSON frame */
            }
          }
          buffer = buffer.slice(split + 2);
        }
      }
    })().catch(() => {
      /* the abort in close() */
    });
    return {
      matching: async (predicate: (event: any) => boolean, what: string, ms = 15_000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const found = events.find(predicate);
          if (found) return found;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      close: () => controller.abort(),
    };
  };

  beforeAll(async () => {
    // The decision endpoint must listen before the harness boots: the
    // calibration gate probes it at startup and a failed probe backs off
    // for a minute, long enough to starve every admission test below.
    decisionServer = createServer((req, res) => {
      res.on("error", () => {});
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [];
          const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as { criteria?: Record<string, string> };
          const criteria = payload.criteria ?? {};
          const canary = Object.hasOwn(criteria, "two");
          let answer: { choice: string; confidence: number; probabilities: Record<string, number> };
          if (canary) {
            answer = { choice: "two", confidence: 0.99, probabilities: { two: 0.99, three: 0.005, seventeen: 0.003, reobserve: 0.001, abstain: 0.001 } };
          } else {
            admissionCalls += 1;
            answer = admissionAnswer();
          }
          const respond = () => {
            if (res.destroyed) return; // the budget aborted this call long ago
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
          };
          if (!canary && admissionOutcome.delayMs) setTimeout(respond, admissionOutcome.delayMs);
          else respond();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => decisionServer.listen(0, "127.0.0.1", resolve));
    const decisionPort = (decisionServer.address() as { port: number }).port;
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    steerGate = join(home, "delayed-steer.gate");
    steerFinishGate = join(home, "finish-steered-turn.gate");
    codexSteerGate = join(home, "codex-steer-refused.gate");
    writeFileSync(codexSteerGate, "refuse live steers until the queue test clears this gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        decisionModel: {
          provider: "custom",
          url: `http://127.0.0.1:${decisionPort}/v1`,
          model: "fake-admission",
          uses: { steerPolicy: true },
          steerPolicy: { queueOverrideThreshold: 0.7, steerOverrideThreshold: 0.9, budgetMs: 250 },
        },
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
          // no live session: a message while busy uses the server-side queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // codex parks its turn on an unanswered question; turn/steer folds
          // new input into that live turn without ending it
          codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1" }, config: { cli: FAKE_CODEX } },
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
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    decisionServer?.closeAllConnections?.();
    decisionServer?.close();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

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
      const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.text}`);
      // order: greeting, first, the fake's opening line, the steered message
      // (appended when it was sent — mid-turn), then ONE reply carrying it
      expect(texts.slice(1)).toEqual([
        "user:first",
        "bot:hello from fake claude",
        "user:and also this",
        "bot:reply to: first + steered: and also this",
      ]);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      // one turn, not two: exactly one reply
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
      // the tool chip keeps its command after the result settles it — the
      // completion patch replaces the whole tool object
      const chip = bot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Bash");
      expect(chip.tool).toMatchObject({ ok: true, summary: "echo hi" });
    },
    40_000,
  );

  it("keeps two queued attachment messages as two native images in one follow-up turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-fake" },
    });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first image task" })).status)
      .toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the image queue turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((message: any) => message.kind === "activity"),
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
    const firstReceipt = await api("POST", `/api/bots/${created.id}/messages`, { text: firstAttachedText });
    const secondReceipt = await api("POST", `/api/bots/${created.id}/messages`, { text: secondAttachedText });

    expect(firstReceipt.status).toBe(202);
    expect(firstReceipt.body).toMatchObject({ ok: true, queued: true });
    expect(firstReceipt.body.steered).toBeUndefined();
    expect(secondReceipt.status).toBe(202);
    expect(secondReceipt.body).toMatchObject({ ok: true, queued: true });
    expect(secondReceipt.body.steered).toBeUndefined();
    expect(
      (await getBot(created.id)).messages.some(
        (message: any) => message.text === firstAttachedText || message.text === secondAttachedText,
      ),
    ).toBe(false);

    await waitFor(
      async () => {
        const messages = (await getBot(created.id)).messages;
        return [firstAttachedText, secondAttachedText].every((text) =>
          messages.some((message: any) => message.text === text),
        );
      },
      "both attached messages to drain",
    );
    await waitFor(async () => (await getBot(created.id)).busy === false, "the attached follow-up to settle");

    const nativeRows = readFileSync(
      join(home, ".openmausbot", "native", `${created.threadId}.ndjson`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const followUp = nativeRows
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .at(-1)?.msg;
    expect(followUp.message.content).toEqual([
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
  }, 40_000);

  // Unskipped 2026-09-16: the first CI run on the PR head (bbed1455, run
  // 35044994016) passed this test on all three OS legs, so the quarantine
  // condition (CI green) is met. The local failure stays recorded: the DELETE 503 is
  // browser-cleanup refusal (restart-the-desktop-app path) on a wedged
  // 900KB fake pipe — environmental on this machine, not the steer hold
  // logic. CI remains the judge.
  it("rejects a delayed steer acknowledgement after the bot is deleted", async () => {
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

    // The fake has paused stdin after the first prompt. This exceeds a pipe's
    // writable buffer, so the steer promise cannot acknowledge until the gate
    // opens; meanwhile the first turn is free to settle normally.
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
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    // the drained line is still the paired person's, not the profile name's
    expect((await getBot(created.id)).messages.find((m: any) => m.text === "second").sender).toEqual(PAIRED);
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

      // This thread is idle, so nothing is steered: the words wait for capacity.
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
    // the unanswered question parks the turn mid-flight, like real work
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.card),
      "the codex question card",
    );

    const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
    expect(second.status).toBe(202);
    expect(second.body.steered).toBe(true);
    const steered = (await getBot(created.id)).messages.find((m: any) => m.text === "and also this");
    expect(steered.steered).toBe(true);

    // the fold reached the app-server as mid-turn input for the SAME turn
    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    expect(steerRow?.params).toMatchObject({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "and also this" }],
      expectedTurnId: "turn-1",
    });

    // Stop ends the turn through the protocol: no signal error anywhere
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
    // ...and they are a paired person's words, which the owner then steers
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
    // pressing Steer moves the words, it does not re-author them
    expect(folded.sender).toEqual(PAIRED);
    expect(steered.body.messages[0].sender).toEqual(PAIRED);

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

    // the endpoint never interrupts on an incapable engine: the queue waits
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

    // Enter still queues in rooms: the send lands as a queued chip, not a turn
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: "steer these room words" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect((await getGroup())?.messages.some((m: any) => m.text === "steer these room words")).toBe(false);

    // the room Steer chip routes through the same non-interrupting fold
    const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, steered: true });
    expect(steered.body.queueIds).toEqual([queued.body.queueId]);
    const folded = (await getGroup())?.messages.find((m: any) => m.text === "steer these room words");
    expect(folded?.steered).toBe(true);
    // the room transcript names speakers from this field: keep the person
    expect(folded?.sender).toEqual(PAIRED);

    // the fold reached the app-server as mid-turn input for the SAME turn
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

    // the room steer endpoint never interrupts an incapable engine: the
    // queue waits for the room's own one-at-a-time drain
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

  // ---- the admission chooser: the calibrated model configured above may
  // override the per-bot preference only at confidence, asymmetrically,
  // and every decision publishes the layer that made it ----

  /** A bot parked mid-turn on the slow fake — the busy 1:1 seam the
  * chooser decides on, with the finish gate cleared so the window stays
  * open until each test releases it. */
  const busyAdmissionTurn = async (text: string) => {
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the admission turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the admission turn tool chip");
    return created;
  };

  it("a confident queue override holds the busy send for the next turn, and the human Steer press reclaims it", async () => {
    const created = await busyAdmissionTurn("refactor the parser module");
    const stream = await admissionStream();
    admissionOutcome = { choice: "queue", confidence: 0.95 };
    try {
      const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "an independent new request" });
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({ ok: true, queued: true });
      expect(typeof second.body.queueId).toBe("string");
      expect((await getBot(created.id)).messages.some((m: any) => m.text === "an independent new request")).toBe(false);
      await stream.matching(
        (event) => event.layer === "model-override" && event.decision === "queue" && event.preference === "steer" && event.confidence === 0.95 && event.detail === "override:queue",
        "the queue override event",
      );
      const steered = await api("POST", `/api/bots/${created.id}/queue/${second.body.queueId}/steer`, { threadId: created.threadId });
      expect(steered.status).toBe(200);
      expect(steered.body.steered).toBe(true);
      const folded = (await getBot(created.id)).messages.find((m: any) => m.text === "an independent new request");
      expect(folded?.steered).toBe(true);
      await stream.matching(
        (event) => event.layer === "human" && event.decision === "steer" && event.preference === "steer" && event.detail === "queue-steer-pressed",
        "the human steer event",
      );
    } finally {
      resetAdmissionOutcome();
      stream.close();
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queue-steered turn to settle");
  }, 40_000);

  it("abstain maps to the preference: the default steers, with the abstention on record", async () => {
    const created = await busyAdmissionTurn("draft the launch plan");
    const stream = await admissionStream();
    admissionOutcome = { choice: "abstain", confidence: 0.99 };
    try {
      const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "keep the tone dry" });
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);
      await stream.matching(
        (event) => event.layer === "preference-default" && event.decision === "steer" && event.preference === "steer" && event.detail === "abstain",
        "the abstain-fallback event",
      );
    } finally {
      resetAdmissionOutcome();
      stream.close();
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the steered turn to settle");
    const folded = (await getBot(created.id)).messages.find((m: any) => m.text === "keep the tone dry");
    expect(folded?.steered).toBe(true);
  }, 40_000);

  it("a decision slower than the hot-path budget times out to the preference without delaying the send", async () => {
    const created = await busyAdmissionTurn("audit the config loader");
    const stream = await admissionStream();
    admissionOutcome = { choice: "steer", confidence: 0.99, delayMs: 800 };
    try {
      const startedAt = Date.now();
      const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "start with the tests" });
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);
      // the 250ms budget fired well before the 800ms answer landed
      expect(Date.now() - startedAt).toBeLessThan(800);
      await stream.matching(
        (event) => event.layer === "preference-default" && event.decision === "steer" && event.preference === "steer" && event.detail === "timeout",
        "the timeout-fallback event",
      );
    } finally {
      resetAdmissionOutcome();
      stream.close();
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the budgeted turn to settle");
  }, 40_000);

  it("a confident steer override beats a queue preference when the reply targets the running turn", async () => {
    const created = await busyAdmissionTurn("draft the launch plan");
    // the turn's opening line is born inside the running turn: replying to
    // it is the steer prior that unlocks the chooser for a queue-preferring bot
    await waitFor(async () => Boolean((await getBot(created.id)).messages.find((m: any) => m.text === "hello from fake claude")), "the running turn's opening line");
    const opening = (await getBot(created.id)).messages.find((m: any) => m.text === "hello from fake claude");
    expect((await api("PATCH", `/api/bots/${created.id}`, { defaultAdmission: "queue" })).status).toBe(200);
    const stream = await admissionStream();
    admissionOutcome = { choice: "steer", confidence: 0.95 };
    try {
      const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "make it two pages, not ten", replyToId: opening.id });
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);
      await stream.matching(
        (event) => event.layer === "model-override" && event.decision === "steer" && event.preference === "queue" && event.confidence === 0.95 && event.detail === "override:steer",
        "the steer override event",
      );
    } finally {
      resetAdmissionOutcome();
      stream.close();
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the overridden turn to settle");
    const folded = (await getBot(created.id)).messages.find((m: any) => m.text === "make it two pages, not ten");
    expect(folded?.steered).toBe(true);
  }, 40_000);

  it("a queue preference without a steer prior stands without a model call", async () => {
    const created = await busyAdmissionTurn("refactor the parser module");
    expect((await api("PATCH", `/api/bots/${created.id}`, { defaultAdmission: "queue" })).status).toBe(200);
    const stream = await admissionStream();
    const before = admissionCalls;
    let queued: { status: number; body: any } | undefined;
    try {
      queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "an unrelated new ask" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, queued: true });
      // the volume cut: no reply targeting the running turn, no model call
      expect(admissionCalls).toBe(before);
      await stream.matching(
        (event) => event.layer === "preference-default" && event.decision === "queue" && event.preference === "queue" && event.detail === "no-steer-prior",
        "the volume-cut event",
      );
    } finally {
      resetAdmissionOutcome();
      stream.close();
      writeFileSync(steerFinishGate, "finish");
    }
    expect(queued?.body?.queued).toBe(true);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.text === "an unrelated new ask"), "the queued ask to drain");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle");
  }, 40_000);
});
