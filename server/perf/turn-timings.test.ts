import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { createTurnTimings, RING_CAP, type SlowNote } from "./turn-timings.ts";

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
