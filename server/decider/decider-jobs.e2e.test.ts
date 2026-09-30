// The taskOutcome and steerSplit jobs, end to end: the real harness with the
// fake claude CLI, and a loopback stand-in for Jev (decider.baseUrl) that
// answers from the state it is sent. Nothing reaches the real API.
//
// - A routine whose reply says it could not finish stays completed, is
//   marked "blocked" on its run and card, and notifies "needs attention";
//   one whose reply reports its result still notifies "finished".
// - A message sent while a turn runs that Jev reads as a separate request
//   is queued as its own item instead of being steered in, and runs as its
//   own turn after the current one; a correction is still steered live.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSse, type SseRecorder } from "../testing/sse.ts";
import { STEER_SPLIT, TASK_OUTCOME } from "./jobs.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "tsk_e2e_fixture_key_0123456789";
const BLOCKED_REPLY = "I couldn't sign in to the billing portal: the password was rejected.";
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("decision-model jobs e2e", () => {
  let child: ChildProcess;
  let jev: Server;
  let home: string;
  let stderr = "";
  let finishGate: string;
  let stream: SseRecorder;
  const asked: Array<{ seam: string; auth: string | undefined; state: Record<string, string>; instructions: string }> = [];

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
  const newBot = async (instanceId: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId, model: "fake-model" } });
    return bot;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    // Jev's wire shape (jev.ts): one choice answer with probabilities.
    jev = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const question = body.questions.answer;
        const state = body.state as Record<string, string>;
        const seam = question.instructions === TASK_OUTCOME.instructions ? "taskOutcome"
          : question.instructions === STEER_SPLIT.instructions ? "steerSplit" : "other";
        asked.push({ seam, auth: req.headers.authorization, state, instructions: question.instructions });
        const choice = seam === "taskOutcome"
          ? (state.final_reply.includes("couldn't") ? "blocked" : "done")
          : state.new_message.includes("cab") ? "separate" : "same";
        const others = Object.keys(question.criteria).filter((key) => key !== choice);
        const probabilities = Object.fromEntries([[choice, 0.94], ...others.map((key) => [key, 0.06 / others.length])]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "jev-fixture", answers: { answer: { type: "choice", choice, probabilities } }, usage: { input_tokens: 90 } }));
      });
    });
    await new Promise<void>((resolve) => jev.listen(0, "127.0.0.1", resolve));
    const jevPort = (jev.address() as AddressInfo).port;

    home = mkdtempSync(join(tmpdir(), "omb-decider-jobs-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        decider: { enabled: true, key: KEY, baseUrl: `http://127.0.0.1:${jevPort}`, jobs: { taskOutcome: true, steerSplit: true } },
        instances: {
          claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeBlocked: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_REPLIES: JSON.stringify([BLOCKED_REPLY]) },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeSlow: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
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
    stream = await openSse(`${BASE}/api/events`);
  }, 30_000);

  afterAll(async () => {
    stream?.close();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    await new Promise<void>((resolve) => jev?.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  const runRoutine = async (botId: string, name: string, prompt: string) => {
    const { routine } = (await api("POST", "/api/routines", {
      name, prompt, botId, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    })).body;
    const { run } = (await api("POST", `/api/routines/${routine.id}/run`)).body;
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    return run.id as string;
  };

  it("a routine whose reply says it could not finish notifies needs attention and is marked, not failed", async () => {
    const bot = await newBot("claudeBlocked");
    const runId = await runRoutine(bot.id, "Morning invoices", "Download yesterday's invoices from the billing portal.");
    const frame = await stream.until((f) => f.kind === "notify" && f.notification?.botId === bot.id, 10_000);
    expect(frame.notification).toMatchObject({ kind: "routine-blocked", title: `${bot.name}'s routine needs attention` });
    await expect.poll(async () => (await runState(runId))?.outcome, { timeout: 5_000 }).toEqual({ kind: "blocked", probability: 0.94 });
    expect((await runState(runId)).status).toBe("completed");
    expect(stream.frames.some((f) => f.kind === "notify" && f.notification?.botId === bot.id && f.notification.kind === "done")).toBe(false);
    const question = asked.find((entry) => entry.seam === "taskOutcome" && entry.state.final_reply === BLOCKED_REPLY);
    expect(question).toBeDefined();
    expect(question!.auth).toBe(`Bearer ${KEY}`);
    expect(Object.keys(question!.state).sort()).toEqual(["final_reply", "task"]);
    expect(question!.state.task).toBe("Morning invoices: Download yesterday's invoices from the billing portal.");
  }, 40_000);

  it("a routine whose reply reports its result still notifies finished", async () => {
    const bot = await newBot("claude");
    const runId = await runRoutine(bot.id, "Weekly brief", "Write the weekly brief.");
    const frame = await stream.until((f) => f.kind === "notify" && f.notification?.botId === bot.id, 10_000);
    expect(frame.notification).toMatchObject({ kind: "done", title: `${bot.name} finished` });
    expect((await runState(runId)).outcome).toBeUndefined();
    expect(asked.some((entry) => entry.seam === "taskOutcome" && entry.state.task === "Weekly brief: Write the weekly brief.")).toBe(true);
  }, 40_000);

  it("a separate request is queued as its own turn; a correction is still steered live", async () => {
    const bot = await newBot("claudeSlow");
    const before = asked.length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Fix the signup button overlapping the footer" })).status).toBe(202);
    await expect.poll(async () => (await getBot(bot.id)).busy, { timeout: 10_000 }).toBe(true);
    // a send to an idle thread never asks
    expect(asked.slice(before).some((entry) => entry.seam === "steerSplit")).toBe(false);

    const separate = await api("POST", `/api/bots/${bot.id}/messages`, { text: "also book me a cab to the airport" });
    expect(separate.status).toBe(202);
    expect(separate.body).toMatchObject({ queued: true, reason: "separate" });
    expect(separate.body.steered).toBeUndefined();
    const split = asked.find((entry) => entry.seam === "steerSplit" && entry.state.new_message === "also book me a cab to the airport");
    expect(split?.state.running_task).toContain("Fix the signup button overlapping the footer");

    const correction = await api("POST", `/api/bots/${bot.id}/messages`, { text: "and make it blue" });
    expect(correction.status).toBe(202);
    expect(correction.body.steered).toBe(true);

    writeFileSync(finishGate, "finish");
    await expect.poll(async () => {
      const messages = (await getBot(bot.id)).messages as any[];
      return messages.filter((m) => m.role === "bot" && m.kind === "text").length;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await getBot(bot.id)).busy, { timeout: 10_000 }).toBe(false);
    const texts = ((await getBot(bot.id)).messages as any[]).filter((m) => m.kind === "text").map((m) => `${m.role}: ${m.text}`);
    const first = texts.findIndex((line) => line.startsWith("bot: ") && line.includes("steered: and make it blue"));
    const cab = texts.indexOf("user: also book me a cab to the airport");
    expect(first).toBeGreaterThan(-1);
    expect(texts[first]).not.toContain("cab");
    // the cab request lands after the first turn's reply and gets its own
    expect(cab).toBeGreaterThan(first);
    expect(texts.slice(cab + 1).some((line) => line.startsWith("bot: ") && line.includes("also book me a cab"))).toBe(true);
  }, 60_000);
});
