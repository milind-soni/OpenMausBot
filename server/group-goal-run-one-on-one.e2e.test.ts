// A one-on-one /goal runs on the room goal-run engine as a room of one, against the isolated fake engine.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const envelope = (decision: Record<string, string>) => `<openmaus-goal>${JSON.stringify(decision)}</openmaus-goal>`;

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let slowGate = "";
let patientGate = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const prompts = (fixture: string): string[] => {
  try {
    return readFileSync(join(home, `${fixture}-prompts.jsonl`), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const newBot = async (name: string, instanceId: string) => (await api("POST", "/api/bots", {
  name,
  modelSelection: { instanceId, model: "claude-sonnet-5" },
  requireAvailableModel: true,
})).body.bot as { id: string; threadId: string };

const messagesIn = async (threadId: string): Promise<any[]> =>
  (await api("GET", `/api/threads/${encodeURIComponent(threadId)}/messages?limit=100`)).body.messages;
const cardIn = async (threadId: string) => (await messagesIn(threadId)).find((message) => message.kind === "goal.run")?.goalRun;
const busy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
const sendGoal = (bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/bots/${bot.id}/messages`, { text, mode: "goal", threadId: bot.threadId, ...extra });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-one-on-one-goal-"));
  slowGate = join(home, "slow-finish");
  patientGate = join(home, "patient-finish");
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  const fixture = (name: string, environment: Record<string, string>) => ({
    driver: "claudeAgent",
    displayName: `${name} fixture`,
    environment: {
      FAKE_CLAUDE_PROMPTS: join(home, `${name}-prompts.jsonl`),
      FAKE_CLAUDE_REPLY_STATE: join(home, `${name}-replies.txt`),
      ...environment,
    },
    config: { cli: FAKE_CLAUDE },
  });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      done: fixture("done", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify([
          `I fixed the parser test.\n${envelope({ status: "continue", next: "Solo", instruction: "Fix the last failing test", detail: "One test left" })}`,
          `Every test passes now.\n${envelope({ status: "completed", detail: "All tests pass." })}`,
        ]),
      }),
      loop: fixture("loop", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(Array.from({ length: 14 }, (_, index) =>
          `Not there yet.\n${envelope({ status: "continue", next: "Looper", instruction: `Try approach ${index + 1}`, detail: "Still working" })}`)),
      }),
      slow: fixture("slow", {
        FAKE_CLAUDE_MODE: "slow",
        FAKE_CLAUDE_SLOW_FINISH_GATE: slowGate,
        FAKE_CLAUDE_REPLIES: JSON.stringify([
          `Halfway.\n${envelope({ status: "continue", next: "Stopper", instruction: "Finish it", detail: "Halfway" })}`,
        ]),
      }),
      patient: fixture("patient", { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_FINISH_GATE: patientGate }),
      crash: fixture("crash", { FAKE_CLAUDE_MODE: "exit-early" }),
      routine: fixture("routine", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify([`Reviewed.\n${envelope({ status: "completed", detail: "Scheduled review done." })}`]),
      }),
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
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("one-on-one goal runs (a room of one)", () => {
  it("works in its own chat until the bot reports the goal done, and the marker never shows", async () => {
    const bot = await newBot("Solo", "done");
    const sent = await sendGoal(bot, "Get every test passing", { sendId: "one_on_one_goal_send_1" });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ role: "user", text: "Get every test passing", channelMode: "goal" });

    await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) }).toMatchObject({
      status: "completed",
      coordinatorBotId: bot.id,
      turnCount: 2,
      maxTurns: 13,
      detail: "All tests pass.",
    });
    await expect.poll(() => busy(bot.id)).toBe(false);

    const sentPrompts = prompts("done");
    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[0]).toContain("You are working alone toward a bounded goal.");
    expect(sentPrompts[0]).toContain("Get every test passing");
    expect(sentPrompts[1]).toContain("Your next step: Fix the last failing test");

    const messages = await messagesIn(bot.threadId);
    const afterGoal = messages.slice(messages.findIndex((message) => message.id === sent.body.message.id) + 1);
    expect(JSON.stringify(messages)).not.toContain("openmaus-goal");
    expect(afterGoal.filter((message) => message.kind === "text" && message.role === "bot").map((message) => message.text))
      .toEqual(["I fixed the parser test.", "Every test passes now."]);
    expect(messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Get every test passing"]);

    const retried = await sendGoal(bot, "Get every test passing", { sendId: "one_on_one_goal_send_1" });
    expect(retried.status).toBe(202);
    expect(retried.body.message.id).toBe(sent.body.message.id);
    expect((await messagesIn(bot.threadId)).filter((message) => message.kind === "goal.run")).toHaveLength(1);
  });

  it("Stop ends the goal on its card and no turn starts after the interrupted one", async () => {
    const bot = await newBot("Stopper", "slow");
    expect((await sendGoal(bot, "Keep going")).status).toBe(202);
    await expect.poll(() => busy(bot.id)).toBe(true);
    expect((await sendGoal(bot, "A second goal")).status).toBe(409);

    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(() => cardIn(bot.threadId)).toMatchObject({ status: "stopped", detail: "Stopped by you.", turnCount: 1 });
    await expect.poll(() => busy(bot.id), { timeout: hostTimeout(10_000) }).toBe(false);
    writeFileSync(slowGate, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await busy(bot.id)).toBe(false);
    expect(await cardIn(bot.threadId)).toMatchObject({ status: "stopped", turnCount: 1 });
    expect(JSON.stringify(await messagesIn(bot.threadId))).not.toContain("Halfway");
  });

  it("waits for the chat's current turn without spending a goal turn, then runs on the same card", async () => {
    const bot = await newBot("Patient", "patient");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Finish this first", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => busy(bot.id)).toBe(true);
    expect((await sendGoal(bot, "Then finish the goal")).status).toBe(202);
    await expect.poll(() => cardIn(bot.threadId)).toMatchObject({
      status: "working",
      turnCount: 0,
      detail: expect.stringMatching(/finishing what it is doing/),
    });
    writeFileSync(patientGate, "observed the waiting goal");
    // The fixture's goal turn ends without a marker, so the run stops after exactly the one turn it waited for.
    await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) })
      .toMatchObject({ status: "blocked", turnCount: 1, detail: "Patient did not provide a valid next-step decision." });
    expect((await messagesIn(bot.threadId)).filter((message) => message.kind === "goal.run")).toHaveLength(1);
  });

  it("stops at the same turn cap as a room goal", async () => {
    const bot = await newBot("Looper", "loop");
    expect((await sendGoal(bot, "Keep trying forever")).status).toBe(202);
    await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(30_000) })
      .toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
    expect(prompts("loop")).toHaveLength(13);
  });

  it("never treats a failed turn as done: it is retried once, then the goal fails", async () => {
    const bot = await newBot("Crasher", "crash");
    expect((await sendGoal(bot, "Do not claim this succeeded")).status).toBe(202);
    await expect.poll(() => cardIn(bot.threadId), { timeout: hostTimeout(15_000) }).toMatchObject({ status: "failed", turnCount: 2 });
  });

  it("a routine runs a goal in the bot's own chat when it names no room", async () => {
    const bot = await newBot("Reviewer", "routine");
    const created = await api("POST", "/api/routines", {
      name: "Daily review",
      prompt: "Review the release",
      target: "room-goal",
      botId: bot.id,
      runOn: "maus",
      schedule: { type: "once", at: Date.now() + 60_000 },
      durationMinutes: 30,
    });
    expect(created.status).toBe(201);
    expect(created.body.routine).toMatchObject({ target: "room-goal", botId: bot.id });
    expect(created.body.routine.groupId).toBeUndefined();

    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const runId = started.body.run.id;
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((run: { id: string }) => run.id === runId),
      { timeout: hostTimeout(15_000) }).toMatchObject({ status: "completed", target: "room-goal", output: "Scheduled review done." });

    const run = (await api("GET", "/api/routines")).body.runs.find((candidate: { id: string }) => candidate.id === runId);
    const owner = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(owner.tasks.some((task: { threadId: string }) => task.threadId === run.threadId)).toBe(true);
    expect(await cardIn(run.threadId)).toMatchObject({ runId, status: "completed", coordinatorBotId: bot.id });
  });

  it("refuses a mode it does not know", async () => {
    const bot = await newBot("Checker", "done");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello", mode: "forever", threadId: bot.threadId })).status).toBe(400);
  });
});
