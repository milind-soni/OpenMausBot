import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { perfHealth, perfLines, turnLine } from "./perf-report.ts";
import { createSetupClock, parseSetupMs, SETUP_STEPS } from "./setup-steps.ts";
import { createTurnTimings } from "./turn-timings.ts";

const START = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(file?: string) {
  let clock = START;
  const timings = createTurnTimings({ now: () => clock, botOf: () => "bot_1", ...(file ? { file } : {}) });
  const emit = (type: string, threadId = "thread_1", turnId = "turn_1", extra: Record<string, unknown> = {}) =>
    timings.noteEvent({ eventId: "e", provider: "claudeAgent", threadId, createdAt: "", turnId, type, ...extra } as RuntimeEvent);
  return { timings, emit, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
const sources = (timings: ReturnType<typeof createTurnTimings>) => ({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: null, process: null });

describe("the setup clock", () => {
  it("gives each lap the time since the one before, adds a name lapped twice, and files the rest as sync", () => {
    let at = 100;
    const queued: Array<() => void> = [];
    const clock = createSetupClock(() => at, (run) => queued.push(run));
    at += 7; queued.shift()!();
    at += 40; clock.lap("compact");
    at += 3; clock.lap("sync");
    at += 250; clock.lap("checkpoint");
    at += 2; clock.lap("sync");
    at += 0.4; clock.lap("browser");
    at += 5;
    expect(clock.done()).toEqual({ total: 307, handoff: 7, compact: 40, checkpoint: 250, sync: 10 });
    at += 90; clock.lap("browser");
    expect(clock.done()).toEqual({ total: 307, handoff: 7, compact: 40, checkpoint: 250, sync: 10 });
  });

  it("takes its first lap by itself once its maker's own work is over, before any awaited step resumes", async () => {
    let at = 0;
    const clock = createSetupClock(() => at);
    at += 12;
    await Promise.resolve();
    at += 30; clock.lap("summaries");
    expect(clock.done()).toEqual({ total: 42, handoff: 12, summaries: 30 });
  });

  it("never goes negative when the clock steps back", () => {
    let at = 100;
    const clock = createSetupClock(() => at, () => {});
    at -= 50; clock.lap("mcp");
    expect(clock.done()).toEqual({ total: 0 });
  });

  it("reads back known steps and numbers only", () => {
    expect(parseSetupMs({ total: 12.4, mcp: 7, "rm -rf /": 3, browser: "4", checkpoint: -1, compact: Number.NaN, __proto__: { apps: 1 } })).toEqual({ total: 12, mcp: 7 });
    expect(parseSetupMs({ mcp: 7 })).toBeUndefined();
    expect(parseSetupMs("total")).toBeUndefined();
  });
});

describe("a turn's setup, recorded with the turn", () => {
  it("rides on the thread's next turn to start, in its record, the hour, the day, the health read and the lines", () => {
    const w = world();
    w.timings.noteSetup("thread_1", { total: 420, checkpoint: 300, mcp: 90, prompt: 20, sync: 10 });
    w.timings.noteSetup("thread_2", { total: 20, prompt: 20 });
    w.emit("turn.started");
    w.emit("turn.started", "thread_2", "turn_2");
    w.advance(1_000);
    w.emit("turn.completed", "thread_1", "turn_1", { ok: true });
    w.emit("turn.completed", "thread_2", "turn_2", { ok: true });
    w.emit("turn.started", "thread_1", "turn_3");
    w.emit("turn.completed", "thread_1", "turn_3", { ok: true });

    const [first, second, third] = w.timings.recent();
    expect(first!.setup).toEqual({ total: 420, checkpoint: 300, mcp: 90, prompt: 20, sync: 10 });
    expect(second!.setup).toEqual({ total: 20, prompt: 20 });
    expect(third!.setup).toBeUndefined();
    expect(turnLine(first!)).toContain("setup 420ms (checkpoint 300ms, mcp 90ms, prompt 20ms)");
    expect(turnLine(third!)).not.toContain("setup");

    const hour = w.timings.window();
    expect(hour.setup.total).toEqual({ p50: 20, p95: 420, max: 420, n: 2 });
    expect(hour.setup.checkpoint).toEqual({ p50: 300, p95: 300, max: 300, n: 1 });
    expect(w.timings.day().setup.total).toMatchObject({ max: 420, n: 2 });

    const health = perfHealth(sources(w.timings));
    expect(Object.keys(health.h1.setup)).toEqual(["total", "checkpoint", "mcp", "prompt", "sync"]);
    expect(health.h24.setup.checkpoint).toMatchObject({ max: 300, n: 1 });
    const lines = perfLines(sources(w.timings), w.timings.recent(), "Latest:");
    expect(lines.filter((line) => line.includes("Turn setup, inside queue"))).toHaveLength(2);
    expect(lines.find((line) => line.includes("Turn setup"))).toContain("total p50 20ms p95 420ms max 420ms; checkpoint p50 300ms p95 300ms max 300ms (1)");
  });

  it("a turn that never started takes no setup into the thread's next turn", () => {
    const w = world();
    w.timings.noteSetup("thread_1", { total: 500, browser: 500 });
    w.timings.noteNotStarted("thread_1", null);
    w.emit("turn.started");
    w.emit("turn.completed", "thread_1", "turn_1", { ok: true });
    expect(w.timings.recent()[0]!.setup).toBeUndefined();
  });

  it("a setup noted hours before a turn starts is not that turn's", () => {
    const w = world();
    w.timings.noteSetup("thread_1", { total: 500 });
    w.advance(3 * 3_600_000);
    w.emit("turn.started");
    w.emit("turn.completed", "thread_1", "turn_1", { ok: true });
    expect(w.timings.recent()[0]!.setup).toBeUndefined();
  });

  it("survives a restart, loads a file written before setups were timed, and drops what is not a known step", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-setup-"));
    dirs.push(dir);
    const file = join(dir, "perf-timings.json");
    const w = world(file);
    w.emit("turn.started");
    w.emit("turn.completed", "thread_1", "turn_1", { ok: true });
    w.timings.noteSetup("thread_1", { total: 80, mcp: 80 });
    w.emit("turn.started", "thread_1", "turn_2");
    w.emit("turn.completed", "thread_1", "turn_2", { ok: true });
    w.timings.flush();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.ring[1].setup["cat /Users/ada/plan.md"] = 5;
    saved.ring[1].setup.browser = "OMB_SECRET";
    delete saved.day[0].setup;
    writeFileSync(file, JSON.stringify(saved));
    const again = createTurnTimings({ file, now: w.now });
    expect(again.recent().map((turn) => turn.setup)).toEqual([undefined, { total: 80, mcp: 80 }]);
    expect(again.day().turns).toBe(2);
    expect(again.day().setup).toEqual({});
  });

  it("takes anything but a setup's numbers as no setup", () => {
    const w = world();
    w.timings.noteSetup("thread_1", { browser: "x" } as never);
    w.emit("turn.started");
    w.emit("turn.completed", "thread_1", "turn_1", { ok: true });
    expect(w.timings.recent()[0]!.setup).toBeUndefined();
    expect(SETUP_STEPS.at(-1)).toBe("total");
  });
});
