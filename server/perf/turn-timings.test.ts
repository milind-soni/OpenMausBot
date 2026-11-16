import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { createTurnTimings, LIVE_TTL_MS, RING_CAP, type SlowNote } from "./turn-timings.ts";

const START = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(options: { file?: string; slowTurnMs?: number; slowToolMs?: number } = {}) {
  let clock = START;
  const slow: SlowNote[] = [];
  const timings = createTurnTimings({ now: () => clock, botOf: () => "bot_1", slow: (note) => slow.push(note), ...options });
  const emit = (event: { type: string } & Record<string, unknown>, threadId = "thread_1", turnId = "turn_1") =>
    timings.noteEvent({ eventId: "e", provider: "claudeAgent", threadId, createdAt: "", turnId, ...event } as RuntimeEvent);
  const say = (threadId = "thread_1", extra: Record<string, unknown> = {}) =>
    timings.noteMessage(threadId, { at: clock, role: "user", kind: "text", ...extra } as never);
  return { timings, emit, say, slow, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("a turn's time, split into phases", () => {
  it("counts each moment once: model, tool, person, resource and retry add up to the whole turn", () => {
    const w = world();
    w.say();
    w.advance(2_000);
    w.emit({ type: "turn.started" });
    w.advance(1_500);
    w.emit({ type: "session.started", sessionId: null });
    w.advance(500);
    w.emit({ type: "content.delta", streamKind: "assistant_text", delta: "x" });
    w.advance(3_000);
    w.emit({ type: "item.started", itemType: "tool", itemId: "a", title: "mcp__browser__navigate" });
    w.advance(1_000);
    w.emit({ type: "request.opened", requestType: "permission", tool: "Bash", summary: "s" });
    w.advance(10_000);
    w.emit({ type: "request.resolved", behavior: "allow", source: "user" });
    w.advance(4_000);
    w.emit({ type: "item.completed", itemType: "tool", itemId: "a", ok: true });
    w.emit({ type: "turn.wait_started", resource: "computer:box:bx_1" });
    w.advance(6_000);
    w.emit({ type: "turn.wait_ended", resource: "computer:box:bx_1", waitedMs: 6_000, outcome: "acquired" });
    w.emit({ type: "turn.retrying", attempt: 1, delayMs: 2_000, reason: "overloaded" });
    w.advance(2_500);
    w.emit({ type: "content.delta", streamKind: "assistant_text", delta: "y" });
    w.advance(1_000);
    w.emit({ type: "turn.completed", ok: true });
    const [turn] = w.timings.recent();
    expect(turn).toMatchObject({
      botId: "bot_1", threadId: "thread_1", turnId: "turn_1", engine: "claudeAgent", ok: true, stop: "ok", queueWhy: "dispatch",
      retries: 1, backoffMs: 2_000, retryWhy: ["overloaded"],
      ms: { queue: 2_000, handshake: 1_500, ttft: 2_000, total: 29_500, model: 6_000, tool: 5_000, person: 10_000, resource: 6_000, retry: 2_500 },
      tools: [{ kind: "browser", n: 1, ms: 15_000, max: 15_000, errors: 0, open: 0 }],
    });
    const { model = 0, tool = 0, person = 0, resource = 0, retry = 0, total } = turn!.ms;
    expect(model + tool + person + resource + retry).toBe(total);
  });

  it("names why the start waited: another turn, the plan's limit, memory", () => {
    const w = world();
    w.emit({ type: "turn.started" });
    w.say();
    w.advance(5_000);
    w.emit({ type: "turn.completed", ok: true });
    w.emit({ type: "turn.started" }, "thread_1", "turn_2");
    w.emit({ type: "turn.completed", ok: true }, "thread_1", "turn_2");
    w.say("thread_2");
    w.timings.noteHeld("thread_2", "plan-limit");
    w.advance(60_000);
    w.emit({ type: "turn.started" }, "thread_2", "turn_3");
    w.emit({ type: "turn.completed", ok: true }, "thread_2", "turn_3");
    expect(w.timings.recent().map((turn) => [turn.turnId, turn.queueWhy, turn.ms.queue])).toEqual([
      ["turn_1", undefined, undefined], ["turn_2", "behind-turn", 5_000], ["turn_3", "plan-limit", 60_000],
    ]);
  });

  it("ignores messages that never wait for a turn of their own", () => {
    const w = world();
    w.say("thread_1", { steered: true });
    w.say("thread_1", { from: { botId: "bot_2" } });
    w.emit({ type: "turn.started" });
    w.emit({ type: "turn.completed", ok: true });
    expect(w.timings.recent()[0]!.ms.queue).toBeUndefined();
  });

  it("files tool calls by kind only, counts failures, and calls still open at the end as left open", () => {
    const w = world();
    w.emit({ type: "turn.started" });
    w.emit({ type: "item.started", itemType: "tool", itemId: "s", title: "pnpm test --filter secret-project", summary: "pnpm test" });
    w.advance(3_000);
    w.emit({ type: "item.completed", itemType: "tool", itemId: "s", ok: false });
    w.emit({ type: "item.started", itemType: "tool", itemId: "m", title: "mcp__acme-internal__lookup_customer" });
    w.emit({ type: "item.started", itemType: "tool", itemId: "c", title: "mcp__computer__screenshot" });
    w.advance(7_000);
    w.emit({ type: "turn.completed", ok: false, stopReason: "Something with words in it" });
    const [turn] = w.timings.recent();
    expect(turn!.stop).toBe("other");
    expect(turn!.tools).toEqual([
      { kind: "mcp", n: 1, ms: 7_000, max: 7_000, errors: 1, open: 1 },
      { kind: "computer", n: 1, ms: 7_000, max: 7_000, errors: 1, open: 1 },
      { kind: "terminal", n: 1, ms: 3_000, max: 3_000, errors: 1, open: 0 },
    ]);
    expect(turn!.ms).toMatchObject({ tool: 10_000, total: 10_000 });
  });

  it("marks a usage limit and a move to a backup AI, and reports slow turns, tool calls and limits", () => {
    const w = world({ slowTurnMs: 60_000, slowToolMs: 30_000 });
    w.emit({ type: "turn.started" });
    w.emit({ type: "item.started", itemType: "tool", itemId: "b", title: "mcp__browser__click" });
    w.advance(45_000);
    w.emit({ type: "item.completed", itemType: "tool", itemId: "b", ok: true });
    w.advance(20_000);
    w.emit({ type: "runtime.error", message: "You've hit your limit", limit: "engine", limitResetsAt: START + 3_600_000 });
    w.timings.noteFailover("thread_1", "limit");
    w.emit({ type: "turn.completed", ok: false, stopReason: "quota" });
    expect(w.timings.recent()[0]).toMatchObject({ limit: "engine", limitResetsAt: START + 3_600_000, failover: "limit", stop: "quota" });
    expect(w.slow.map((note) => note.kind)).toEqual(["tool", "limit", "turn"]);
    expect(w.timings.day()).toMatchObject({ turns: 1, failed: 1, limits: { "claudeAgent:engine": 1 }, failovers: 1, slow: [1, 0, 0] });
  });

  it("shows what a running turn is doing now and for how long", () => {
    const w = world();
    w.emit({ type: "turn.started" });
    w.advance(1_000);
    w.emit({ type: "item.started", itemType: "tool", itemId: "b", title: "mcp__browser__navigate" });
    w.advance(37 * 60_000);
    expect(w.timings.live()).toEqual([{ botId: "bot_1", threadId: "thread_1", engine: "claudeAgent", ageMs: 37 * 60_000 + 1_000, state: "tool", stateMs: 37 * 60_000, tool: "browser" }]);
  });

  it("gives exact percentiles for the last hour and bucketed ones for the day", () => {
    const w = world();
    for (let index = 1; index <= 20; index++) {
      w.emit({ type: "turn.started" }, "thread_1", `t${index}`);
      w.advance(index * 1_000);
      w.emit({ type: "turn.completed", ok: true }, "thread_1", `t${index}`);
    }
    expect(w.timings.window().phases.total).toEqual({ p50: 10_000, p95: 19_000, max: 20_000, n: 20 });
    const day = w.timings.day().phases.total!;
    expect(day.n).toBe(20);
    expect(day.max).toBe(20_000);
    expect(day.p50).toBeGreaterThanOrEqual(10_000);
    expect(day.p95).toBe(20_000);
    w.advance(2 * 3_600_000);
    expect(w.timings.window().turns).toBe(0);
    expect(w.timings.day().turns).toBe(20);
  });
});

describe("the ring and its file", () => {
  it("keeps the latest RING_CAP turns, survives a restart and drops anything malformed in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-timings-"));
    dirs.push(dir);
    const file = join(dir, "perf-timings.json");
    const w = world({ file });
    for (let index = 0; index < RING_CAP + 25; index++) {
      w.emit({ type: "turn.started" }, "thread_1", `t${index}`);
      w.advance(100);
      w.emit({ type: "turn.completed", ok: true }, "thread_1", `t${index}`);
    }
    w.timings.flush();
    expect(statSync(file).size).toBeLessThan(150_000);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.ring.push({ startedAt: 1, endedAt: 2, threadId: "../../etc/passwd", engine: "claude --api-key=sk-x", tools: [{ kind: "rm -rf /", n: 1 }] });
    writeFileSync(file, JSON.stringify(saved));
    const again = createTurnTimings({ file, now: w.now });
    const recent = again.recent();
    expect(recent).toHaveLength(RING_CAP);
    expect(recent[0]!.turnId).toBe("t26");
    expect(recent.at(-1)).toMatchObject({ threadId: null, engine: null, tools: [] });
    expect(again.day().turns).toBe(RING_CAP + 25);
  });
});

describe("turns that never ran", () => {
  it("a start refused by a usage limit with a backup AI: one refused record with its limit, the backup's turn with the move, nothing left running", () => {
    const w = world();
    w.say();
    w.emit({ type: "turn.started" }, "thread_1", "turn_refused");
    w.advance(2_000);
    w.timings.noteNotStarted("thread_1", "turn_refused", { limit: "engine", engine: "claudeAgent", resetsAt: START + 3_600_000 });
    w.timings.noteFailover("thread_1", "limit");
    w.advance(500);
    w.timings.noteEvent({ eventId: "e", provider: "codex", threadId: "thread_1", createdAt: "", turnId: "turn_backup", type: "turn.started" } as RuntimeEvent);
    w.advance(3_000);
    w.timings.noteEvent({ eventId: "e", provider: "codex", threadId: "thread_1", createdAt: "", turnId: "turn_backup", type: "turn.completed", ok: true } as RuntimeEvent);
    expect(w.timings.recent().map(({ turnId, engine, stop, limit, failover }) => ({ turnId, engine, stop, limit, failover }))).toEqual([
      { turnId: "turn_refused", engine: "claudeAgent", stop: "quota", limit: "engine", failover: undefined },
      { turnId: "turn_backup", engine: "codex", stop: "ok", limit: undefined, failover: "limit" },
    ]);
    expect(w.timings.day()).toMatchObject({ turns: 2, limits: { "claudeAgent:engine": 1 }, failovers: 1 });
    expect(w.timings.live()).toEqual([]);
    expect(w.slow.map((note) => note.kind)).toEqual(["limit"]);
  });

  it("a start refused with no backup leaves no phantom running turn", () => {
    const w = world();
    w.emit({ type: "turn.started" }, "thread_1", "turn_refused");
    w.timings.noteNotStarted("thread_1", "turn_refused", { signedOut: true });
    expect(w.timings.live()).toEqual([]);
    expect(w.timings.recent()).toMatchObject([{ turnId: "turn_refused", stop: "auth_required", ok: false }]);
  });

  it("the server's own refusal before any engine ran counts the limit, times no turn, and leaves another thread's turn alone", () => {
    const w = world();
    w.emit({ type: "turn.started" }, "thread_2", "turn_other");
    w.timings.noteNotStarted("thread_1", "signed-out-1", { limit: "model", engine: "claudeAgent" });
    w.timings.noteNotStarted("thread_2", "not-that-turn", {});
    expect(w.timings.day()).toMatchObject({ turns: 0, limits: { "claudeAgent:model": 1 } });
    expect(w.timings.live()).toHaveLength(1);
  });

  it("a turn replaced by a new one in its thread is finished as stopped, not dropped", () => {
    const w = world();
    w.emit({ type: "turn.started" }, "thread_1", "turn_a");
    w.advance(1_000);
    w.emit({ type: "turn.started" }, "thread_1", "turn_b");
    expect(w.timings.recent()).toMatchObject([{ turnId: "turn_a", stop: "other", ok: false, ms: { total: 1_000 } }]);
    expect(w.timings.live()).toMatchObject([{ state: "model" }]);
  });
});

describe("a message whose turn never starts", () => {
  it("does not time the next turn from it, three hours on", () => {
    for (const end of ["refused", "failure row", "age"] as const) {
      const w = world();
      w.say();
      if (end === "refused") w.timings.noteNotStarted("thread_1", null);
      if (end === "failure row") w.timings.noteMessage("thread_1", { at: w.now(), role: "bot", kind: "activity", tool: { name: "error: x", ok: false } } as never);
      w.advance(3 * 3_600_000);
      w.say();
      w.advance(1_000);
      w.emit({ type: "turn.started" });
      w.emit({ type: "turn.completed", ok: true });
      expect(w.timings.recent()[0]!.ms.queue, end).toBe(1_000);
    }
  });

  it("keeps the wait across the server's own notices while the turn waits", () => {
    const w = world();
    w.say();
    w.timings.noteHeld("thread_1", "memory");
    w.timings.noteMessage("thread_1", { at: w.now(), role: "bot", kind: "activity", tool: { name: "notice: Waiting for memory", ok: true } } as never);
    w.advance(90_000);
    w.emit({ type: "turn.started" });
    w.emit({ type: "turn.completed", ok: true });
    expect(w.timings.recent()[0]).toMatchObject({ queueWhy: "memory", ms: { queue: 90_000 } });
  });
});

describe("what counts as slow, and odd clocks", () => {
  it("time waiting on a person never makes a turn slow, and is still reported", () => {
    const w = world({ slowTurnMs: 60_000 });
    w.emit({ type: "turn.started" });
    w.emit({ type: "request.opened", requestType: "question", tool: "AskUserQuestion", summary: "s" });
    w.advance(20 * 60_000);
    w.emit({ type: "request.resolved", behavior: "answer", source: "user" });
    w.advance(30_000);
    w.emit({ type: "turn.completed", ok: true });
    expect(w.timings.recent()[0]!.ms).toMatchObject({ person: 20 * 60_000, total: 20 * 60_000 + 30_000 });
    expect(w.timings.day().slow).toEqual([0, 0, 0]);
    expect(w.timings.window().slow).toEqual([0, 0, 0]);
    expect(w.slow).toEqual([]);
  });

  it("a clock set back mid-turn gives zero, never a negative duration", () => {
    const w = world();
    w.emit({ type: "turn.started" });
    w.advance(-10_000);
    w.emit({ type: "session.started", sessionId: null });
    w.emit({ type: "content.delta", streamKind: "assistant_text", delta: "x" });
    const [live] = w.timings.live();
    expect(live!.ageMs).toBe(0);
    expect(live!.stateMs).toBe(0);
    w.emit({ type: "turn.completed", ok: true });
    const { ms } = w.timings.recent()[0]!;
    expect(Object.values(ms).every((value) => value >= 0)).toBe(true);
    expect(ms).toMatchObject({ handshake: 0, ttft: 0, total: 0 });
  });

  it("a turn past the live limit leaves the running list; one waiting on a person is finished as such", () => {
    const w = world();
    w.emit({ type: "turn.started" }, "thread_1", "lost");
    w.emit({ type: "turn.started" }, "thread_2", "asking");
    w.emit({ type: "request.opened", requestType: "question", tool: "AskUserQuestion", summary: "s" }, "thread_2", "asking");
    w.advance(LIVE_TTL_MS + 1);
    expect(w.timings.live()).toEqual([]);
    expect(w.timings.recent()).toMatchObject([{ turnId: "asking", stop: "waiting_on_person", ms: { person: LIVE_TTL_MS + 1 } }]);
  });

  it("keys from outside never reach an object's prototype", () => {
    const w = world();
    w.emit({ type: "turn.started" });
    for (const reason of ["constructor", "__proto__", "toString", "hasOwnProperty", "rate_limited"]) w.emit({ type: "turn.retrying", attempt: 1, delayMs: 0, reason });
    w.emit({ type: "turn.completed", ok: false, stopReason: "constructor" });
    w.timings.noteNotStarted("thread_9", null, { limit: "engine", engine: "__proto__" });
    w.timings.noteNotStarted("thread_9", null, { limit: "engine", engine: "constructor" });
    const day = w.timings.day();
    expect({ ...day.retries.why }).toEqual({ other: 4 });
    expect(w.timings.recent()[0]).toMatchObject({ retryWhy: ["other", "other", "other", "other"], stop: "other" });
    expect(Object.keys(day.limits).sort()).toEqual(["constructor:engine", "unknown:engine"]);
    expect(JSON.stringify(day)).not.toContain("native code");
  });
});
