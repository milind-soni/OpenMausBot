import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorldSnapshot } from "../scorers/snapshot.ts";
import { loadJudgePrompt, parseJudgeVerdict } from "./judge/judge.ts";
import { loadLiveInstance, runLiveMain } from "./run-live.ts";
import {
  applyThresholds,
  evaluateLiveChecks,
  loadLiveConfig,
  loadLiveScenarios,
  scenarioScore,
  suiteScore,
  toScenario,
} from "./live-suite.ts";
import { liveConfigSchema, liveScenarioSchema, type LiveScenario, type LiveScenarioOutcome } from "./types.ts";

function snapshot(overrides: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    turns: [],
    handoffs: [],
    activeThreads: {},
    threads: {},
    sends: [],
    observations: {},
    activities: () => [],
    resolve: (value) => value,
    ...overrides,
  };
}

const live: LiveScenario = liveScenarioSchema.parse({
  id: "unit-live",
  title: "unit",
  behavior: "behavior",
  bots: [{ key: "chief", name: "Chief", chiefOfStaff: true }],
  steps: [
    { kind: "send", bot: "chief", text: "do it" },
    { kind: "waitForBusy", bot: "chief", busy: false },
    { kind: "waitForNodeStatus", bot: "maker", status: "completed" },
  ],
  invariants: [
    { kind: "sendNotQueued", bot: "chief" },
    { kind: "botReplied", bot: "chief", thread: "active" },
  ],
});

describe("toScenario", () => {
  it("fills wait timeouts from config, derives gates, and drops live-only invariants", () => {
    const config = loadLiveConfig();
    const scenario = toScenario(live, config);
    expect(scenario.bots.every((bot) => bot.turns.length === 0)).toBe(true);
    expect(scenario.steps[1]).toMatchObject({ kind: "waitForBusy", timeoutMs: config.turnTimeoutMs });
    expect(scenario.steps[2]).toMatchObject({ kind: "waitForNodeStatus", timeoutMs: config.turnTimeoutMs });
    expect(scenario.steps[0]).not.toHaveProperty("timeoutMs");
    expect(scenario.assertions.map((assertion) => assertion.kind)).toEqual(["sendNotQueued"]);
    expect(scenario.gates).toEqual([]);
  });
});

describe("evaluateLiveChecks", () => {
  it("scores assertion invariants and botReplied against the frozen snapshot", () => {
    const world = snapshot({
      sends: [{ bot: "chief", text: "do it", queued: false }],
      activeThreads: { chief: "t1" },
      threads: { t1: [{ role: "user", text: "do it" }, { role: "bot", text: "done" }] },
    });
    expect(evaluateLiveChecks(live, world)).toEqual([
      { kind: "sendNotQueued", pass: true, detail: expect.any(String) },
      { kind: "botReplied", pass: true, detail: expect.any(String) },
    ]);

    const silent = snapshot({
      sends: [{ bot: "chief", text: "do it", queued: false }],
      activeThreads: { chief: "t2" },
      threads: { t2: [{ role: "user", text: "do it" }] },
    });
    expect(evaluateLiveChecks(live, silent).find((check) => check.kind === "botReplied")?.pass).toBe(false);
  });
});

describe("scoring and thresholds", () => {
  const outcome = (score: number): LiveScenarioOutcome => ({ id: "x", title: "t", behavior: "b", checks: [], score });

  it("averages check pass rates into scenario and suite scores", () => {
    expect(scenarioScore([{ kind: "a", pass: true, detail: "" }, { kind: "b", pass: false, detail: "" }])).toBe(0.5);
    expect(scenarioScore([])).toBe(0);
    expect(suiteScore([outcome(1), outcome(0.5)])).toBe(0.75);
    expect(suiteScore([])).toBe(0);
  });

  it("applies the committed min-score bar and baseline drift limit", () => {
    const committed = loadLiveConfig();
    expect(applyThresholds(committed, 0.9).pass).toBe(true);
    expect(applyThresholds(committed, 0.5).pass).toBe(false);

    const driftConfig = liveConfigSchema.parse({
      minScore: 0.5,
      maxDrift: 0.25,
      turnTimeoutMs: 60_000,
      judgeTimeoutMs: 30_000,
      maxJudgeRetries: 1,
    });
    expect(applyThresholds(driftConfig, 0.55, 0.9).pass).toBe(false);
    expect(applyThresholds(driftConfig, 0.55, 0.9).minScoreMet).toBe(true);
    expect(applyThresholds(driftConfig, 0.9, 0.95)).toEqual({ pass: true, minScoreMet: true, drift: 0.04999999999999993 });
  });
});

describe("committed live scenarios", () => {
  it("parse and keep the offline gate off by default", () => {
    expect(loadLiveScenarios().map((scenario) => scenario.id).sort()).toEqual([
      "live-delegation-lane",
      "live-open-ended-judge",
    ]);
  });
});

describe("judge prompts", () => {
  it("verify the manifest checksum and refuse unknown versions", () => {
    const prompt = loadJudgePrompt("open-ended-v1");
    expect(prompt.text).toContain("{{task}}");
    expect(prompt.text).toContain("{{reply}}");
    expect(() => loadJudgePrompt("missing-v9")).toThrow(/no judge prompt version/);
  });

  it("parses strict verdicts from plain, fenced, or prose-wrapped replies", () => {
    const verdict = { score: 0.5, pass: false, reasons: ["partial"] };
    expect(parseJudgeVerdict(JSON.stringify(verdict))).toEqual(verdict);
    expect(parseJudgeVerdict("Here you go: " + JSON.stringify(verdict) + " thanks")).toEqual(verdict);
    expect(() => parseJudgeVerdict("no json here")).toThrow(/not valid JSON/);
    expect(() => parseJudgeVerdict('{"score": 5, "pass": true, "reasons": []}')).toThrow();
  });
});

describe("live instance loading", () => {
  const instance = { instanceId: "local", driver: "ollama", config: {}, model: "qwen3:1.7b" };

  it("reads inline JSON", () => {
    expect(loadLiveInstance({ OMB_EVAL_LIVE_INSTANCE: JSON.stringify(instance) })).toMatchObject({
      instanceId: "local",
      model: "qwen3:1.7b",
    });
  });

  it("reads a config path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "live-instance-")), "instance.json");
    writeFileSync(path, JSON.stringify(instance));
    expect(loadLiveInstance({ OMB_EVAL_LIVE_CONFIG: path })).toMatchObject({ instanceId: "local" });
  });

  it("fails closed with neither source set", () => {
    expect(() => loadLiveInstance({})).toThrow(/no engine instance is configured/);
  });
});

describe("live gate", () => {
  const previous = process.env.OMB_EVAL_LIVE;

  afterEach(() => {
    if (previous === undefined) delete process.env.OMB_EVAL_LIVE;
    else process.env.OMB_EVAL_LIVE = previous;
  });

  it("is off by default: runLiveMain skips without touching any model", async () => {
    delete process.env.OMB_EVAL_LIVE;
    await expect(runLiveMain([])).resolves.toBe(0);
  });
});
