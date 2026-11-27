import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPerfHost } from "./perf-host.ts";
import { recentTurnStarts, TURN_STARTS_KEPT, turnStartClock } from "./turn-starts.ts";

describe("one line per ACP engine turn on how its start went", () => {
  it("names a new process's steps, its config calls and its first update, in numbers and fixed words only", () => {
    const logged: string[] = [];
    const clock = turnStartClock("antigravityAgent", 1_000, (line) => logged.push(line));
    clock.waited("models", 12);
    clock.spawned(Date.now());
    for (const [method, ms] of [["initialize", 8_200], ["authenticate", 310], ["session/resume", 1_500], ["session/set_config_option", 200], ["session/set_config_option", 150]] as const) clock.call(method, ms);
    clock.promptSent(50_000);
    clock.firstUpdate(52_300);
    clock.firstUpdate(53_000);
    clock.call("session/set_config_option", 99);
    const line = clock.finish("end_turn", 61_000)!;
    expect(line).toMatch(/^\[perf\] engine turn antigravityAgent: new process, models waited 12 ms, spawn to initialize \d+ ms, authenticate 310 ms, session resume 1500 ms, config 2 calls 350 ms, prompt to first update 2300 ms, total 60\.0 s, ended end_turn$/u);
    expect(logged).toEqual([line]);
    expect(clock.finish("again", 62_000)).toBeNull();
    expect(recentTurnStarts().at(-1)).toBe(line);
  });

  it("says when the process was kept and no session call was needed, and never repeats a word it was not given", () => {
    const clock = turnStartClock("ada@example.test", 0, () => {});
    clock.promptSent(10);
    const line = clock.finish("/Users/ada/secret", 20)!;
    expect(line).toBe("[perf] engine turn acp: kept process, models waited 0 ms, session live, config 0 calls 0 ms, prompt to first update none, total 20 ms, ended other");
    expect(turnStartClock("x", 0, () => {}).finish("auth_required", 5)).toBe("[perf] engine turn x: no process, models waited 0 ms, config 0 calls 0 ms, no prompt, total 5 ms, ended auth_required");
  });

  it("keeps only the latest lines, and they are in the diagnostics export", () => {
    for (let index = 0; index < TURN_STARTS_KEPT + 5; index++) turnStartClock("codex", 0, () => {}).finish("end_turn", index);
    expect(recentTurnStarts()).toHaveLength(TURN_STARTS_KEPT);
    const dir = mkdtempSync(join(tmpdir(), "turn-starts-"));
    try {
      const perf = createPerfHost({
        dataDir: dir, timer: false, wholeMachine: false, log: () => {},
        bus: { subscribe: () => () => {} }, store: { onChange: () => () => {}, botByThread: () => null },
      });
      const text = perf.text();
      expect(text).toContain("## Engine turn starts (latest, oldest first)");
      expect(text).toContain(recentTurnStarts().at(-1)!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
