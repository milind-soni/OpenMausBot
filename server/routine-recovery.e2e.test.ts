// Unattended routine runs that recover by themselves: the real server and Claude driver, with the fake engine's mode
// read from a file at each launch, and the stall watchdog's twenty minutes brought forward by a marker file.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const STALLED = "No activity for 20 minutes — the routine was stopped";
const SIGN_IN = "This bot's AI is signed out. Sign in again in Settings → Model providers.";
const ROUTINE_HEADER = '[Routine "Inbox brief" — do this now:]';

let fixture: VerificationServer | undefined;
let restarted: ChildProcess | undefined;
let events: SseRecorder | undefined;
afterEach(async () => {
  events?.close();
  await waitForExit(restarted, { signal: "SIGTERM" });
  await fixture?.close();
  fixture = restarted = events = undefined;
});

async function server(env: NodeJS.ProcessEnv = {}) {
  fixture = await launchVerificationServer({ ...process.env, ...env });
  const { url, dataDir, logPath } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const dump = join(dataDir, "claude-turn.json");
  const engine = (mode: string, extra: Record<string, string> = {}) =>
    writeFileSync(join(dataDir, "engine.json"), JSON.stringify({ FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_DUMP: dump, ...extra }));
  const wrapper = join(dataDir, "claude-scripted.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    `Object.assign(process.env, JSON.parse(readFileSync(${JSON.stringify(join(dataDir, "engine.json"))}, "utf8")));`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  engine("happy");
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  // Chief first makes the starter its team's Chief, which answers a teammate's failed run with a Team incidents turn of
  // its own on the same engine. Stepped down, what these runs tell the owner is theirs alone.
  const starter = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.chiefOfStaff);
  await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
  const bot = (await runControlOmb(["new-bot", "--name", "Inbox bot", "--url", url]) as any).bot;
  events = await openSse(`${url}/api/events`, { origin: url });
  const routine = async (name = "Inbox brief") => (await api("POST", "/api/routines", {
    name, prompt: "Summarise my inbox.", botId: bot.id, schedule: { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" },
  })).routine;
  const runs = async () => {
    try { return (await api("GET", "/api/routines")).runs as any[]; } catch { return []; }
  };
  const run = async (id: string) => (await runs()).find((candidate) => candidate.id === id);
  const runNow = async (routineId: string) => (await api("POST", `/api/routines/${routineId}/run`)).run;
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; title: string; body: string });
  /** The engine has the turn, so the stall marker can find it watched; with `text`, the turn whose prompt says it. */
  const engineHas = (text = "Summarise my inbox.") => expect.poll(() => {
    try { return JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt).includes(text); } catch { return false; }
  }, { timeout: hostTimeout(30_000) }).toBe(true);
  /** The server has read the engine's announcement of its `turns`th turn in this thread: a hanging turn sends nothing
   * after it, and a frame read once the stall marker exists starts that turn's stall window over. */
  const engineAnnounced = (threadId: string, turns: number) => expect.poll(() => {
    try {
      return readFileSync(join(dataDir, "native", `${threadId}.ndjson`), "utf8").split("\n")
        .filter((line) => line.includes('"dir":"in"') && line.includes('"subtype":"init"')).length;
    } catch { return 0; }
  }, { timeout: hostTimeout(30_000) }).toBeGreaterThanOrEqual(turns);
  const prompts = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[])
    .filter((message) => message.role === "user").map((message) => String(message.text ?? ""));
  return { url, dataDir, logPath, api, bot, engine, dump, engineHas, engineAnnounced, routine, runs, run, runNow, notified, prompts };
}

it("never starts a routine again that the turn watchdog stopped as stalled: it fails at once, and its owner hears once", async () => {
  const s = await server({ OMB_TEST_STALL_CLOCK: "1" });
  s.engine("hang");
  const { id } = await s.runNow((await s.routine()).id);
  await s.engineHas();
  const { threadId } = await s.run(id);
  // The marker stalls only the turns already watched, and quiet, when it is written.
  await s.engineAnnounced(threadId, 1);
  writeFileSync(join(s.dataDir, "stall-turns"), "");

  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(30_000) }).toBe("failed");
  const failed = await s.run(id);
  expect(failed).toMatchObject({ error: STALLED });
  expect(failed.retried).toBeUndefined();
  await expect.poll(() => s.notified().filter((notification) => notification.kind === "routine-failed"), { timeout: hostTimeout(15_000) })
    .toEqual([expect.objectContaining({ title: "Inbox bot's routine failed", body: `Inbox brief: ${STALLED}` })]);
  expect((await s.prompts(threadId)).filter((text) => text.includes(ROUTINE_HEADER))).toHaveLength(1);
}, hostTimeout(120_000));

it("starts a routine that crashed again once, and it completes in the same conversation", async () => {
  const s = await server();
  s.engine("exit-early");
  const { id } = await s.runNow((await s.routine()).id);
  await expect.poll(async () => (await s.run(id))?.retried, { timeout: hostTimeout(30_000) }).toBe("failed");
  const { threadId } = await s.run(id);
  expect(await s.run(id)).toMatchObject({ status: "queued" });
  s.engine("happy");

  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(60_000) }).toBe("completed");
  expect(await s.run(id)).toMatchObject({ retried: "failed", threadId });
  expect(JSON.stringify(JSON.parse(readFileSync(s.dump, "utf8")).prompt)).toContain("this run's first start failed before it finished");
  expect((await s.prompts(threadId)).filter((text) => text.includes(ROUTINE_HEADER))).toHaveLength(2);
  expect(s.notified().filter((notification) => notification.kind === "routine-failed")).toEqual([]);
}, hostTimeout(120_000));

it("fails a routine that crashes again on its retry, says so, and never retries it a second time", async () => {
  const s = await server();
  s.engine("exit-early");
  const { id } = await s.runNow((await s.routine()).id);
  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(90_000) }).toBe("failed");
  const failed = await s.run(id);
  expect(failed).toMatchObject({ retried: "failed", error: expect.stringMatching(/^Failed after one automatic retry: /) });
  await expect.poll(() => s.notified().filter((notification) => notification.kind === "routine-failed"), { timeout: hostTimeout(15_000) })
    .toEqual([expect.objectContaining({ title: "Inbox bot's routine failed", body: `Inbox brief: ${failed.error}` })]);
  expect((await s.prompts(failed.threadId)).filter((text) => text.includes(ROUTINE_HEADER))).toHaveLength(2);
  expect(await s.runs()).toHaveLength(1);
}, hostTimeout(150_000));

it("picks a run that a restart cut off up again once on the next start, and never runs it twice", async () => {
  const s = await server();
  // Exiting slowly, as taskkill does on Windows, the engine ends its turn while the server is still shutting down.
  s.engine("hang", { FAKE_CLAUDE_EXIT_DELAY_MS: "1500" });
  const { id } = await s.runNow((await s.routine()).id);
  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(15_000) }).toBe("running");
  const { threadId } = await s.run(id);

  await waitForExit(fixture!.child, { signal: "SIGTERM" });
  expect(JSON.parse(readFileSync(join(s.dataDir, "routines.json"), "utf8")).runs).toMatchObject([{ id, status: "running" }]);
  s.engine("happy");
  const log = openSync(s.logPath, "a", 0o600);
  const env = verificationServerEnvironment({}, s.dataDir, Number(new URL(s.url).port));
  restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
  closeSync(log);

  await expect.poll(async () => (await s.run(id))?.retried, { timeout: hostTimeout(20_000) }).toBe("restarted");
  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(60_000) }).toBe("completed");
  expect(await s.runs()).toMatchObject([{ id, threadId, retried: "restarted", status: "completed" }]);
  expect(JSON.stringify(JSON.parse(readFileSync(s.dump, "utf8")).prompt)).toContain("this run's first start was cut off when OpenMausBot restarted");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const sent = await s.prompts(threadId);
  expect(sent.filter((text) => text.includes(ROUTINE_HEADER))).toHaveLength(2);
  expect(sent.join("\n")).not.toContain("restarted while your previous turn here was running");
  expect(await s.runs()).toHaveLength(1);
  // The cut turn's own job is closed, so nothing can take it up again beside the second start.
  const roots = readHandoffs(s.dataDir).filter((node) => node.threadId === threadId && !node.parentId);
  expect(roots.map((node) => node.status)).toEqual(["cancelled", "completed"]);
}, hostTimeout(120_000));

it("keeps an ACP engine's run that a graceful shutdown cut off, and starts it once more on the next start", async () => {
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["cline"]);
  const { url, dataDir, logPath } = fixture.info;
  const configPath = join(dataDir, "config.json");
  const acpMode = (mode: string) => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.cline.environment.FAKE_ACP_MODE = mode;
    writeFileSync(configPath, JSON.stringify(config));
  };
  const restart = async () => {
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { timeout: hostTimeout(30_000) }).toBe(true);
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => (await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  acpMode("hang");
  await restart();
  const { bot } = await cli("new-bot", "--name", "Inbox bot");
  await cli("set-model", "--bot", bot.id, "--instance", "cline", "--model", "cline-default");
  const { routine } = await api("POST", "/api/routines", { name: "Inbox brief", prompt: "Summarise my inbox.", botId: bot.id,
    schedule: { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" } });
  const { run } = await api("POST", `/api/routines/${routine.id}/run`);
  const read = async () => ((await api("GET", "/api/routines").catch(() => ({ runs: [] }))).runs as any[]).find((candidate) => candidate.id === run.id);
  await expect.poll(async () => (await read())?.status, { timeout: hostTimeout(15_000) }).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  await waitForExit(restarted, { signal: "SIGTERM" });
  expect(JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).runs).toMatchObject([{ id: run.id, status: "running" }]);
  acpMode("happy");
  await restart();
  await expect.poll(async () => (await read())?.status, { timeout: hostTimeout(60_000) }).toBe("completed");
  expect(await read()).toMatchObject({ retried: "restarted" });
}, hostTimeout(120_000));

it("waits for the conversation it joins to be free instead of failing, then runs there", async () => {
  const s = await server();
  s.engine("hang", { FAKE_CLAUDE_RELEASE: join(s.dataDir, "release") });
  await runControlOmb(["send", "--bot", s.bot.id, "--task", s.bot.activeTaskId, "--text", "Draft the weekly update.", "--url", s.url]);
  await expect.poll(async () => (await s.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === s.bot.id)?.busy, { timeout: hostTimeout(15_000) }).toBe(true);

  const { routine } = await s.api("POST", "/api/routines", {
    name: "Inbox brief", prompt: "Summarise my inbox.", botId: s.bot.id, schedule: { type: "limit_reset", engine: "claude" },
  });
  const { id } = await s.runNow(routine.id);
  await expect.poll(() => s.run(id), { timeout: hostTimeout(15_000) }).toMatchObject({
    status: "queued", threadId: s.bot.activeTaskId, deferredAt: expect.any(Number),
    attention: "Waiting to start: this thread is already working — interrupt it first",
  });
  writeFileSync(join(s.dataDir, "release"), "");

  await expect.poll(async () => (await s.run(id))?.status, { timeout: hostTimeout(60_000) }).toBe("completed");
  const done = await s.run(id);
  expect(done).toMatchObject({ threadId: s.bot.activeTaskId, output: "released" });
  expect(done.retried).toBeUndefined();
  expect(s.notified().filter((notification) => notification.kind === "routine-failed")).toEqual([]);
}, hostTimeout(120_000));

it("never retries a signed-out engine, and tells the owner exactly once what to do", async () => {
  const s = await server();
  s.engine("not-logged-in");
  const first = await s.runNow((await s.routine()).id);
  await expect.poll(async () => (await s.run(first.id))?.status, { timeout: hostTimeout(15_000) }).toBe("failed");
  const second = await s.runNow((await s.routine("Calendar check")).id);
  await expect.poll(async () => (await s.run(second.id))?.status, { timeout: hostTimeout(15_000) }).toBe("failed");
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  for (const id of [first.id, second.id]) {
    const run = await s.run(id);
    expect(run.error).toBe(`${SIGN_IN} The AI said: “Not logged in · Please run /login”`);
    expect(run.retried).toBeUndefined();
  }
  expect(s.notified()).toEqual([
    expect.objectContaining({ kind: "routine-failed", title: "Inbox bot's routine failed", body: `Inbox brief: ${SIGN_IN}` }),
  ]);
  expect((await s.prompts(first.threadId ?? (await s.run(first.id)).threadId)).filter((text) => text.includes(ROUTINE_HEADER))).toHaveLength(1);
}, hostTimeout(90_000));

it("waits for a usage limit that says when it resets, instead of failing", async () => {
  const s = await server();
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  s.engine("usage-limit", { FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt }) });
  const { id } = await s.runNow((await s.routine()).id);

  await expect.poll(() => s.run(id), { timeout: hostTimeout(15_000) }).toMatchObject({
    status: "queued", retried: "usage_limit", retryAt: resetsAt * 1000 + 60_000,
    attention: expect.stringMatching(/^Waiting for the AI's usage limit to reset; this run starts again at /),
  });
  await expect.poll(() => s.notified(), { timeout: hostTimeout(15_000) }).toEqual([
    expect.objectContaining({ kind: "routine-deferred", title: "Inbox bot's routine is waiting",
      body: expect.stringMatching(/^Inbox brief: This bot's AI reached its usage limit\. This run starts again at /) }),
  ]);
  expect((await s.run(id)).error).toBeUndefined();
  expect((await s.api("GET", "/api/routines")).routines[0].failureStreak).toBeUndefined();
}, hostTimeout(90_000));
