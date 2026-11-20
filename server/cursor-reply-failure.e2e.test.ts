// A failed model call Cursor sends as its reply, on the real server: the isolated fixture with a cursorAgent instance backed
// by the fake ACP CLI, which replays cursor-agent 2026.10.22's sequence from an updates file it re-reads at each prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { INCIDENTS_THREAD_TITLE } from "./incidents.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const engineId = "cursor-fixture";
// The failure chunk, a backgrounded shell Cursor waits on, then end_turn.
const FAILED_CALL = [
  { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nError: RetriableError: [unavailable] HTTP 503" } } },
  { update: { sessionUpdate: "tool_call", toolCallId: "watch-1", title: "Watching: wait until 06:15", kind: "other" } },
  { update: { sessionUpdate: "tool_call_update", toolCallId: "watch-1", status: "completed" } },
];
const TEMPORARY_PROBLEM = "Cursor had a temporary server problem (HTTP 503)";

let fixture: VerificationServer | undefined;
let restarted: ChildProcess | undefined;
let events: SseRecorder | undefined;
let evidence: unknown[] = [];
afterEach(async () => {
  events?.close();
  if (fixture) writeFileSync(`${fixture.info.logPath}.cursor-reply-failure.json`, JSON.stringify({ evidence }, null, 2));
  await waitForExit(restarted, { signal: "SIGTERM" });
  fixture = restarted = events = undefined;
  evidence = [];
});

async function cursorServer({ keepChief }: { keepChief: boolean }) {
  fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const updatesFile = join(dataDir, "cursor-updates.json");
  evidence.push({ fixture: fixture.info, provider: "fake cursor-agent ACP, no network" });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const configPath = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances[engineId] = { driver: "cursorAgent", displayName: "Cursor fixture",
    config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
    environment: { FAKE_ACP_VERSION: "2026.10.22-27dcf5f", FAKE_ACP_MODELS_LIST: "auto-only", FAKE_ACP_UPDATES_FILE: updatesFile } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(updatesFile, JSON.stringify(FAILED_CALL));
  const log = openSync(logPath, "a", 0o600);
  restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
  });
  closeSync(log);
  await expect.poll(async () => {
    try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 25_000 }).toBe(true);

  const chief = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.chiefOfStaff);
  if (!keepChief && chief) await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
  const bot = (await control("new-bot", "--name", "Cursor routine")).bot;
  const threadId: string = bot.activeTaskId ?? bot.threadId;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: engineId, model: "auto" }, updateBotDefault: true });
  events = await openSse(`${url}/api/events`, { origin: url });

  const runRoutine = async () => {
    const { routine } = await api("POST", "/api/routines", { name: "Morning post", prompt: "Post the queue.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {}, 201);
    return async () => {
      const { routines, runs } = await api("GET", "/api/routines");
      const current = { routine: routines.find((candidate: any) => candidate.id === routine.id), run: runs.find((candidate: any) => candidate.id === run.id) };
      evidence.push({ at: Date.now(), ...current });
      return current;
    };
  };
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; title: string; body: string });
  return { api, control, bot, threadId, chief, updatesFile, runRoutine, notified };
}

it("fails a Cursor turn on the failed call it sends as its reply, and never shows the raw line", async () => {
  const s = await cursorServer({ keepChief: false });
  expect((await s.control("send", "--bot", s.bot.id, "--task", s.threadId, "--text", "Post the queue.")).success).toBe(true);
  expect((await s.control("wait", "--bot", s.bot.id, "--task", s.threadId, "--timeout", "30")).state).toBe("failed");
  const { messages } = await s.control("messages", "--bot", s.bot.id, "--task", s.threadId, "--limit", "20");
  expect(messages.some((message: any) => JSON.stringify(message).includes("RetriableError"))).toBe(false);
  expect(messages).toContainEqual(expect.objectContaining({ kind: "activity", tool: expect.objectContaining({
    ok: false, name: expect.stringContaining(TEMPORARY_PROBLEM) }) }));
}, 120_000);

it("retries a routine run once on that failure, and it completes when the retry succeeds", async () => {
  const s = await cursorServer({ keepChief: false });
  const state = await s.runRoutine();
  await expect.poll(async () => { const { status, retried } = (await state()).run; return { status, retried }; }, { timeout: 30_000, interval: 500 })
    .toEqual({ status: "queued", retried: "provider" });
  writeFileSync(s.updatesFile, "[]");
  await expect.poll(async () => (await state()).run.status, { timeout: 60_000, interval: 1_000 }).toBe("completed");
  expect(s.notified().filter((notification) => notification.kind === "routine-failed")).toEqual([]);
}, 120_000);

it("fails a routine run whose retry fails too, counts it, and tells the Chief", async () => {
  const s = await cursorServer({ keepChief: true });
  const state = await s.runRoutine();
  await expect.poll(async () => (await state()).run.status, { timeout: 60_000, interval: 1_000 }).toBe("failed");
  const { routine, run } = await state();
  expect(run).toMatchObject({ retried: "provider", error: expect.stringMatching(/^Failed after one automatic retry: Cursor had a temporary server problem \(HTTP 503\)/) });
  expect(routine.failureStreak).toBe(1);
  await expect.poll(() => s.notified().filter((notification) => notification.kind === "routine-failed"), { timeout: 15_000 })
    .toEqual([expect.objectContaining({ title: "Cursor routine's routine failed", body: `Morning post: ${run.error}` })]);
  await expect.poll(async () => (await s.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === s.chief.id).tasks
    .map((task: any) => task.title), { timeout: 15_000 }).toContain(INCIDENTS_THREAD_TITLE);
}, 120_000);
