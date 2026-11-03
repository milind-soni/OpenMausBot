import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { TRIAL_CREDIT_REFUSED } from "../shared/trial-credit.ts";
import {
  classifyRoutineFailure, dispatchRefusal, retryNote, ROUTINE_BUSY_RECHECK_MS, ROUTINE_BUSY_WAIT_MS, weekRuns, type RoutineAlert,
} from "./routine-recovery.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START = new Date(2026, 7, 17, 8, 0, 0).getTime();
const SECOND = 1_000;
const MINUTE = 60_000;
const ROUTING = "stream error: workspace routing discovery failed: error sending request";
const STALL = "No activity for 20 minutes — the routine was stopped";
const SIGNED_OUT = "Not logged in · Please run /login";
const SIGN_IN_ACTION = "This bot's AI is signed out. Sign in again in Settings → AI.";
const BUSY = "this thread is already working — interrupt it first";
const CRASH = "claude exited 3 before result: fake-claude: simulated crash before result";
const CAPPED = "Stopped after 40 tool calls without a final answer";
const DENIED = "One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.";
const NO_HOURS = "This month's cloud desktop hours are used up. See your plan on the Plan page.";
type EventBody = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;

function harness(extra: Partial<RoutineManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-recovery-"));
  dirs.push(dir);
  let now = START;
  let tasks = 0;
  let refusal: Error | null = null;
  const attempts: string[] = [];
  const started: Array<{ threadId: string; prompt: string }> = [];
  const failed: Array<{ run: RoutineRun; alert: RoutineAlert | null | undefined }> = [];
  const deferred: Array<{ run: RoutineRun; alert?: RoutineAlert }> = [];
  const cut: RoutineRun[] = [];
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async (_botId, threadId, prompt) => {
      attempts.push(threadId);
      if (refusal) throw refusal;
      started.push({ threadId, prompt });
    },
    onRunFailed: (run, alert) => failed.push({ run, alert }),
    onRunDeferred: (run, alert) => deferred.push({ run, alert }),
    onRunCut: (run) => cut.push(run),
    ...extra,
  };
  let manager = new RoutineManager(options);
  const event = (threadId: string, body: EventBody) =>
    manager.handleRuntimeEvent({ eventId: `event-${Math.random()}`, provider: "fake", threadId, createdAt: new Date(0).toISOString(), ...body } as RuntimeEvent);
  return {
    options, attempts, started, failed, deferred, cut,
    get manager() { return manager; },
    restart: () => { manager = new RoutineManager(options); return manager; },
    tasks: () => tasks,
    refuse: (error: Error | null) => { refusal = error; },
    advance: async (ms: number) => { now += ms; await manager.tick(); },
    runs: () => manager.listRuns(),
    run: (id: string) => manager.listRuns().find((run) => run.id === id)!,
    routine: (botId = "maus-1", name = "Inbox sweep") =>
      manager.create({ name, prompt: "Sweep the inbox", botId, schedule: { type: "daily", time: "09:00", weekdays: [3] } }),
    start: async (routineId: string) => {
      const run = manager.runNow(routineId)!;
      await manager.tick();
      return manager.listRuns().find((candidate) => candidate.id === run.id)!;
    },
    event,
    fail: (threadId: string, message: string, extra: { stopReason?: string } & Partial<Extract<RuntimeEvent, { type: "runtime.error" }>> = {}) => {
      const { stopReason, ...flags } = extra;
      event(threadId, { type: "runtime.error", message, ...flags });
      event(threadId, { type: "turn.completed", ok: false, stopReason: stopReason ?? null });
    },
    complete: (threadId: string, text = "Inbox swept.") => {
      event(threadId, { type: "item.completed", itemType: "assistant_text", text });
      event(threadId, { type: "turn.completed", ok: true });
    },
  };
}

describe("classifyRoutineFailure", () => {
  it.each<[string, Parameters<typeof classifyRoutineFailure>[1], ReturnType<typeof classifyRoutineFailure>]>([
    // The turn watchdog's stall is never retried; an engine's own stall is.
    [STALL, { cause: "stalled" }, { kind: "final" }],
    ["OpenCode sent nothing for 10 minutes with no tool running, so the turn was stopped as stuck.", { stalled: true, stopReason: "rpc_error" }, { kind: "retry", cause: "stalled" }],
    [BUSY, { cause: "busy" }, { kind: "busy" }],
    ["xAI hit a rate limit (HTTP 429). Wait a minute, then run it again.", {}, { kind: "retry", cause: "rate_limited" }],
    ["Claude is overloaded right now (HTTP 529). This is usually temporary, so try again in a few minutes.", {}, { kind: "retry", cause: "provider" }],
    [ROUTING, {}, { kind: "retry", cause: "provider" }],
    [SIGNED_OUT, { setup: true, stopReason: "auth_required" }, { kind: "owner", cause: "signed_out" }],
    ["workspace routing discovery unauthorized (401)", {}, { kind: "owner", cause: "signed_out" }],
    ["Your xAI account is out of credits (xAI says: \"Your team has run out of credits\"). Add credits with xAI, then run it again.", {}, { kind: "owner", cause: "credits" }],
    ["Internal error: API error (status 402 Payment Required): pay up", { setup: true, stopReason: "auth_required" }, { kind: "owner", cause: "credits" }],
    [TRIAL_CREDIT_REFUSED.used_up, { setup: true, trialCredit: "used_up" }, { kind: "owner", cause: "credits" }],
    ["This Claude account has reached its 5-hour limit.", { stopReason: "quota", limitResetsAt: START + 3_600_000 }, { kind: "owner", cause: "usage_limit", resetsAt: START + 3_600_000 }],
    ["You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)", {}, { kind: "owner", cause: "usage_limit" }],
    ["Claude Code is too old for this model. Update it.", { setup: true, stopReason: "update_required" }, { kind: "owner", cause: "setup" }],
    ["The engine stopped without saying why (stop reason: cancelled).", { stopReason: "cancelled" }, { kind: "final" }],
    ["the turn was interrupted", {}, { kind: "final" }],
    // Any other failure gets one retry...
    [CRASH, {}, { kind: "retry", cause: "failed" }],
    ["The bot did not complete this run", {}, { kind: "retry", cause: "failed" }],
    // ...except a stop someone pressed or typed, a refusal and a spent cap.
    [CRASH, { stopReason: "interrupted" }, { kind: "final" }],
    ["Provider settings changed while this thread was running", { stopReason: "interrupted" }, { kind: "final" }],
    ["The engine stopped without saying why (stop reason: refusal).", { stopReason: "refusal" }, { kind: "final" }],
    ["The model refused the request (HTTP 400): unsupported model", {}, { kind: "final" }],
    [CAPPED, {}, { kind: "final" }],
    ["Model-call limit reached before a final answer", {}, { kind: "final" }],
    ["The bot repeated the same call 6 times, so it was stopped", { cause: "cap" }, { kind: "final" }],
    ["this workspace has reached its monthly spend limit of $20.00", { cause: "cap" }, { kind: "final" }],
    ["The routine was deleted before it could start", { cause: "refused" }, { kind: "final" }],
    [DENIED, { stopReason: "tool_error" }, { kind: "final" }],
    // A start that failed before its turn began is judged by its words, and never retried as a crash.
    [NO_HOURS, { cause: "refused" }, { kind: "final" }],
    [CRASH, { cause: "refused" }, { kind: "final" }],
    [SIGNED_OUT, { cause: "refused" }, { kind: "owner", cause: "signed_out" }],
    ["xAI hit a rate limit (HTTP 429). Wait a minute, then run it again.", { cause: "refused" }, { kind: "retry", cause: "rate_limited" }],
  ])("%s", (failure, facts, verdict) => {
    expect(classifyRoutineFailure(failure, facts)).toEqual(verdict);
  });

  it("reads a busy refusal from its code, never its words", () => {
    expect(dispatchRefusal(Object.assign(new Error(BUSY), { status: 409, code: "thread_busy" }))).toEqual({ cause: "busy" });
    expect(dispatchRefusal(Object.assign(new Error("this provider account is being updated"), { status: 409, code: "settling" }))).toEqual({ cause: "busy" });
    expect(dispatchRefusal("thread_busy")).toEqual({});
  });

  it("reads the spend cap and any other refusal to start, and leaves an engine that would not spawn a plain failure", () => {
    expect(dispatchRefusal(Object.assign(new Error("this workspace has reached its monthly spend limit of $20.00"), { status: 409, code: "spend_cap" }))).toEqual({ cause: "cap" });
    expect(dispatchRefusal(Object.assign(new Error(BUSY), { status: 409 }))).toEqual({ cause: "refused" });
    expect(dispatchRefusal(Object.assign(new Error("no such bot"), { status: 404 }))).toEqual({ cause: "refused" });
    expect(dispatchRefusal(new Error("spawn claude ENOENT"))).toEqual({});
  });
});

describe("an unattended run that fails for a passing reason", () => {
  it("starts again once in its own thread, tells the engine to check what it already did, and completes", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.event("thread-1", { type: "item.started", itemType: "tool", itemId: "t1", title: "shell" });
    h.event("thread-1", { type: "item.completed", itemType: "assistant_text", text: "Half done" });
    h.fail("thread-1", ROUTING);
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "provider", threadId: "thread-1", retryAt: START + 15 * SECOND,
      attention: `Starting again shortly after a temporary error: ${ROUTING}` });
    expect(h.failed).toEqual([]);

    await h.advance(14 * SECOND);
    expect(h.started).toHaveLength(1);
    await h.advance(2 * SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(h.started[1]!.prompt).toBe(`${h.started[0]!.prompt}\n\n${retryNote("provider")}`);
    h.complete("thread-1");
    expect(h.run(run.id)).toMatchObject({ status: "completed", retried: "provider", output: "Inbox swept.", attention: undefined, error: undefined });
    expect(h.tasks()).toBe(1);
  });

  it("fails the second time, and says it was retried", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail("thread-1", ROUTING);
    await h.advance(16 * SECOND);
    h.fail("thread-1", ROUTING);
    expect(h.run(run.id)).toMatchObject({ status: "failed", retried: "provider", error: `Failed after one automatic retry: ${ROUTING}` });
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.alert).toBeUndefined();
    await h.advance(MINUTE);
    expect(h.started).toHaveLength(2);
  });

  it("waits a minute after a rate limit", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail("thread-1", "Claude hit a rate limit (HTTP 429). Wait a minute, then run it again.");
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "rate_limited", retryAt: START + MINUTE });
    await h.advance(59 * SECOND);
    expect(h.started).toHaveLength(1);
    await h.advance(2 * SECOND);
    expect(h.started).toHaveLength(2);
  });

  it("starts again once after its engine stalled, ignores the stalled turn's own end, and fails on a second stall", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    const engineStall = "OpenCode sent nothing for 10 minutes with no tool running, so the turn was stopped as stuck.";
    h.fail("thread-1", engineStall, { stalled: true, stopReason: "rpc_error" });
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "stalled", attention: `Starting again shortly after the AI stalled: ${engineStall}` });
    h.event("thread-1", { type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(h.run(run.id).status).toBe("queued");
    await h.advance(16 * SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(h.started[1]!.prompt).toContain(retryNote("stalled"));

    h.fail("thread-1", engineStall, { stalled: true, stopReason: "rpc_error" });
    expect(h.run(run.id)).toMatchObject({ status: "failed", retried: "stalled", error: `Failed after one automatic retry: ${engineStall}` });
    expect(h.failed.map(({ run: failed }) => failed.id)).toEqual([run.id]);
  });

  it("never starts a run again that the turn watchdog stopped as stalled: its owner and Chief hear at once", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.manager.failThread("thread-1", STALL, { cause: "stalled" });
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: STALL });
    expect(h.run(run.id).retried).toBeUndefined();
    await h.advance(MINUTE);
    expect(h.started).toHaveLength(1);
    expect(h.failed.map(({ run: failed }) => failed.id)).toEqual([run.id]);
  });

  it("retries any other failure once, then fails it and tells of it once: a second failure is never retried", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.fail("thread-1", CRASH);
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "failed", attention: `Starting again shortly after a failure: ${CRASH}` });
    expect(h.failed).toEqual([]);
    await h.advance(16 * SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(h.started[1]!.prompt).toBe(`${h.started[0]!.prompt}\n\n${retryNote("failed")}`);

    h.fail("thread-1", CRASH);
    expect(h.run(run.id)).toMatchObject({ status: "failed", retried: "failed", error: `Failed after one automatic retry: ${CRASH}` });
    expect(h.failed.map(({ run: failed }) => failed.id)).toEqual([run.id]);
    await h.advance(MINUTE);
    expect(h.started).toHaveLength(2);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ["a Stop the owner pressed or typed", (h) => h.fail("thread-1", CRASH, { stopReason: "interrupted" })],
    ["a turn cap", (h) => h.fail("thread-1", CAPPED)],
    ["the repeat guard", (h) => h.manager.failThread("thread-1", "The bot repeated the same call 6 times, so it was stopped", { cause: "cap" })],
    ["an AI that declined", (h) => h.fail("thread-1", "I can't help with that.", { stopReason: "refusal" })],
    ["a tool call the person denied", (h) => h.fail("thread-1", DENIED, { stopReason: "tool_error" })],
  ])("never retries a run ended by %s", async (_what, end) => {
    const h = harness();
    const run = await h.start(h.routine().id);
    end(h);
    expect(h.run(run.id).status).toBe("failed");
    expect(h.run(run.id).retried).toBeUndefined();
    await h.advance(MINUTE);
    expect(h.started).toHaveLength(1);
  });

  it("never retries a run whose start failed before its turn began", async () => {
    const dispatchErrors: Array<(message: string) => void> = [];
    const h = harness({ startTurn: async (_botId, _threadId, _prompt, _runOn, _trigger, onDispatchError) => { dispatchErrors.push(onDispatchError); } });
    const run = await h.start(h.routine().id);
    dispatchErrors[0]!(NO_HOURS);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: NO_HOURS });
    expect(h.run(run.id).retried).toBeUndefined();
    await h.advance(MINUTE);
    expect(dispatchErrors).toHaveLength(1);
  });

  it("never retries a run the spend cap kept from starting", async () => {
    const h = harness();
    h.refuse(Object.assign(new Error("this workspace has reached its monthly spend limit of $20.00"), { status: 409, code: "spend_cap" }));
    const run = await h.start(h.routine().id);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: "this workspace has reached its monthly spend limit of $20.00" });
    h.refuse(null);
    await h.advance(MINUTE);
    expect(h.attempts).toHaveLength(1);
  });

  it("never starts a room goal again by itself", async () => {
    const h = harness({ goalState: () => "ready", createGoalTask: () => ({ threadId: "goal-1" }), startGoal: async () => {} });
    const routine = h.manager.create({ name: "Team goal", prompt: "Ship it", botId: "maus-1", target: "room-goal", groupId: "group-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    const run = await h.start(routine.id);
    h.manager.failThread("goal-1", "Claude is overloaded right now (HTTP 529).");
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: "Claude is overloaded right now (HTTP 529)." });
    expect(h.run(run.id).retried).toBeUndefined();
    const signedOut = await h.start(routine.id);
    h.manager.failThread("goal-1", "workspace routing discovery unauthorized (401)", { cause: "busy" });
    expect(h.run(signedOut.id)).toMatchObject({ status: "failed", error: "workspace routing discovery unauthorized (401)" });
    expect(h.failed.map(({ alert }) => alert)).toEqual([undefined, undefined]);
  });
});

describe("an unattended run whose bot is busy when it starts", () => {
  const busy = () => Object.assign(new Error(BUSY), { status: 409, code: "thread_busy" });

  it("waits in its own thread instead of failing, then runs once the bot is free", async () => {
    const h = harness();
    h.refuse(busy());
    const run = await h.start(h.routine().id);
    expect(h.run(run.id)).toMatchObject({ status: "queued", threadId: "thread-1", deferredAt: START, retryAt: START + ROUTINE_BUSY_RECHECK_MS,
      attention: `Waiting to start: ${BUSY}` });
    expect(h.run(run.id).retried).toBeUndefined();
    expect(h.failed).toEqual([]);
    await h.advance(ROUTINE_BUSY_RECHECK_MS - SECOND);
    expect(h.attempts).toHaveLength(1);

    // A wait is not a retry, and a restart leaves it waiting.
    h.restart();
    expect(h.run(run.id)).toMatchObject({ status: "queued", deferredAt: START });
    expect(h.run(run.id).retried).toBeUndefined();
    expect(h.cut).toEqual([]);

    h.refuse(null);
    await h.advance(2 * SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1"]);
    expect(h.started[0]!.prompt).not.toContain("OpenMausBot: this run's first start");
    h.complete("thread-1");
    expect(h.run(run.id)).toMatchObject({ status: "completed", attention: undefined });
    expect(h.run(run.id).retried).toBeUndefined();
    expect(h.tasks()).toBe(1);
  });

  it("stops waiting after an hour, and a refusal without a busy code fails at once", async () => {
    const h = harness();
    h.refuse(busy());
    const run = await h.start(h.routine().id);
    for (let waited = 0; waited < ROUTINE_BUSY_WAIT_MS; waited += ROUTINE_BUSY_RECHECK_MS) await h.advance(ROUTINE_BUSY_RECHECK_MS);
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: `Did not start: still busy after 60 minutes (${BUSY})` });
    expect(h.failed).toHaveLength(1);

    const other = harness();
    other.refuse(Object.assign(new Error('provider instance "gone" is unavailable — pick another model in settings'), { status: 409 }));
    const refused = await other.start(other.routine().id);
    expect(other.run(refused.id)).toMatchObject({ status: "failed", error: 'provider instance "gone" is unavailable — pick another model in settings' });
  });
});

describe("an unattended run only its owner can fix", () => {
  it("fails a sign-in error at once, and tells the owner once per bot until one of its runs completes", async () => {
    const h = harness();
    const first = await h.start(h.routine("maus-1", "Inbox sweep").id);
    h.fail("thread-1", SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(h.run(first.id)).toMatchObject({ status: "failed", error: `${SIGN_IN_ACTION} The AI said: “${SIGNED_OUT}”` });
    expect(h.run(first.id).retried).toBeUndefined();
    expect(h.failed.map(({ alert }) => alert)).toEqual([{ detail: SIGN_IN_ACTION }]);
    await h.advance(5 * MINUTE);
    expect(h.attempts).toHaveLength(1);

    const second = await h.start(h.routine("maus-1", "Calendar check").id);
    h.fail(second.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    const elsewhere = await h.start(h.routine("maus-2", "Other bot").id);
    h.fail(elsewhere.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(h.failed.map(({ alert }) => alert)).toEqual([{ detail: SIGN_IN_ACTION }, null, { detail: SIGN_IN_ACTION }]);
    expect(JSON.parse(readFileSync(h.options.file!, "utf8")).ownerNotices).toMatchObject([
      { botId: "maus-1", cause: "signed_out" }, { botId: "maus-2", cause: "signed_out" },
    ]);

    // Across a restart it stays told; a completed run of that bot is what clears it.
    h.restart();
    const third = await h.start(h.manager.listRoutines().find((routine) => routine.name === "Inbox sweep")!.id);
    h.fail(third.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(h.failed.at(-1)!.alert).toBeNull();
    const fixed = await h.start(h.manager.listRoutines().find((routine) => routine.name === "Calendar check")!.id);
    h.complete(fixed.threadId!);
    const fourth = await h.start(h.manager.listRoutines().find((routine) => routine.name === "Inbox sweep")!.id);
    h.fail(fourth.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(h.failed.at(-1)!.alert).toEqual({ detail: SIGN_IN_ACTION });
  });

  it("starts a signed-out run once more on the backup the person chose, and fails it as before when there is none", async () => {
    const scopes: unknown[] = [];
    const h = harness({ limitBackup: (botId, scope) => { scopes.push(scope); return botId === "maus-1"; } });
    const run = await h.start(h.routine("maus-1").id);
    h.fail(run.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(scopes).toEqual(["signed-out"]);
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "failed", attention: "Starting again on the backup AI: this bot's AI is signed out" });
    expect(h.failed).toEqual([]);
    await h.advance(20 * SECOND);
    expect(h.attempts).toEqual([run.threadId, run.threadId]);

    const other = await h.start(h.routine("maus-2").id);
    h.fail(other.threadId!, SIGNED_OUT, { setup: true, stopReason: "auth_required" });
    expect(h.run(other.id)).toMatchObject({ status: "failed", error: `${SIGN_IN_ACTION} The AI said: “${SIGNED_OUT}”` });
  });

  it("fails an out-of-credit refusal at once with what to do, and the trial credit says to sign in", async () => {
    const h = harness();
    const credits = "Your xAI account is out of credits (xAI says: \"Your team has run out of credits\"). Add credits with xAI, then run it again.";
    const run = await h.start(h.routine("maus-1").id);
    h.fail("thread-1", credits, { stopReason: "rpc_error" });
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: credits });
    expect(h.failed[0]!.alert).toEqual({ detail: "This bot's AI account is out of credit. Add credit with the provider, or choose another AI for this bot." });

    const trial = await h.start(h.routine("maus-2").id);
    h.fail(trial.threadId!, TRIAL_CREDIT_REFUSED.used_up, { setup: true, trialCredit: "used_up" });
    expect(h.run(trial.id)).toMatchObject({ status: "failed", error: TRIAL_CREDIT_REFUSED.used_up });
    expect(h.failed[1]!.alert).toEqual({ detail: "The trial Claude credit can't run this. Sign in with your own Claude or ChatGPT account, or add an API key." });
  });

  it("waits out a usage limit that resets within twelve hours, once, and says so once", async () => {
    const h = harness();
    const resetsAt = START + 2 * 3_600_000;
    const limit = "This Claude account has reached its 5-hour limit, which resets soon. Until then, switch this bot to another AI or Claude account.";
    const run = await h.start(h.routine().id);
    h.fail("thread-1", limit, { stopReason: "quota", limitResetsAt: resetsAt });
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "usage_limit", retryAt: resetsAt + MINUTE, threadId: "thread-1",
      attention: expect.stringMatching(/^Waiting for the AI's usage limit to reset; this run starts again at /) });
    expect(h.failed).toEqual([]);
    expect(h.deferred).toEqual([expect.objectContaining({ alert: { detail: expect.stringMatching(/^This bot's AI reached its usage limit\. This run starts again at .+\.$/) } })]);
    expect(h.manager.wakeHold()).toEqual({ hold: false });
    expect(h.manager.wakeHold(3 * 3_600_000)).toEqual({ hold: true, reason: "due", at: resetsAt + MINUTE });

    await h.advance(2 * 3_600_000);
    expect(h.started).toHaveLength(1);
    await h.advance(MINUTE + SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(h.started[1]!.prompt).toContain(retryNote("usage_limit"));
    h.fail("thread-1", limit, { stopReason: "quota", limitResetsAt: START + 5 * 3_600_000 });
    expect(h.run(run.id)).toMatchObject({ status: "failed", error: limit });
    expect(h.failed[0]!.alert).toBeNull();
    expect(h.deferred).toHaveLength(1);
  });

  it("fails a usage limit with no reset time, or one too far off, and tells the owner", async () => {
    const h = harness();
    const run = await h.start(h.routine("maus-1").id);
    h.fail("thread-1", "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)", { stopReason: "quota" });
    expect(h.run(run.id).status).toBe("failed");
    const far = await h.start(h.routine("maus-2").id);
    h.fail(far.threadId!, "This Claude account has reached its weekly limit.", { stopReason: "quota", limitResetsAt: START + 13 * 3_600_000 });
    expect(h.run(far.id).status).toBe("failed");
    const action = "This bot's AI reached its usage limit. Its routines work again once it resets, or choose another AI for this bot now.";
    expect(h.failed.map(({ alert }) => alert)).toEqual([{ detail: action }, { detail: action }]);
    expect(h.deferred).toEqual([]);
  });
});

describe("a run that OpenMausBot's shutdown cuts off", () => {
  it("stays running through the shutdown, and the next start picks it up once in its own thread", async () => {
    const h = harness();
    const run = await h.start(h.routine().id);
    h.manager.close();
    h.event("thread-1", { type: "turn.completed", ok: true, stopReason: "cancelled" });
    h.fail("thread-1", "The engine stopped without saying why (stop reason: interrupted).", { stopReason: "interrupted" });
    h.manager.failThread("thread-1", STALL, { cause: "stalled" });
    expect(h.run(run.id).status).toBe("running");
    expect(JSON.parse(readFileSync(h.options.file!, "utf8")).runs[0].status).toBe("running");
    expect(h.failed).toEqual([]);

    h.restart();
    expect(h.run(run.id)).toMatchObject({ status: "queued", retried: "restarted", threadId: "thread-1", attention: "Starting again shortly after OpenMausBot restarted while it ran" });
    expect(h.cut.map((cut) => cut.id)).toEqual([run.id]);
    h.restart();
    expect(h.cut).toHaveLength(1);
    await h.advance(16 * SECOND);
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(h.started[1]!.prompt).toContain(retryNote("restarted"));
    expect(h.runs()).toHaveLength(1);
  });
});

describe("weekRuns", () => {
  it("counts the runs that finished in the last seven days, and how many completed", () => {
    const run = (status: RoutineRun["status"], finishedAt: number, routineId = "r1") =>
      ({ id: `${status}-${finishedAt}`, routineId, status, finishedAt, createdAt: finishedAt }) as RoutineRun;
    const day = 24 * 3_600_000;
    const runs = [run("completed", START), run("failed", START - day), run("missed", START - 2 * day), run("completed", START - 8 * day),
      run("cancelled", START), run("queued", START), run("completed", START, "r2")];
    expect(weekRuns(runs, "r1", START)).toEqual({ ok: 1, total: 3 });
    expect(weekRuns(runs, "r3", START)).toBeUndefined();
  });

  it("rides on each routine the list shows", async () => {
    const h = harness();
    const routine = h.routine();
    const run = await h.start(routine.id);
    h.complete(run.threadId!);
    expect(h.manager.listRoutines()[0]).toMatchObject({ id: routine.id, weekRuns: { ok: 1, total: 1 } });
    expect(JSON.parse(readFileSync(h.options.file!, "utf8")).routines[0]).not.toHaveProperty("weekRuns");
  });
});
