import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, Scenario, Step } from "../types.ts";
import { evaluateAssertions } from "../scorers/assertions.ts";
import type { WorldSnapshot } from "../scorers/snapshot.ts";
import {
  liveConfigSchema,
  liveScenarioSchema,
  type LiveCheckResult,
  type LiveConfig,
  type LiveInvariant,
  type LiveScenario,
  type LiveScenarioOutcome,
} from "./types.ts";

/** Tier-3 glue: loading, adapting, checking and scoring live scenarios.
 * Pure functions only — everything that touches a server or a real model
 * lives in run-live.ts, so all of this is unit-testable offline. */

const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)));
export const LIVE_SCENARIOS_DIR = join(LIVE_DIR, "scenarios");
export const LIVE_BASELINES_DIR = join(LIVE_DIR, "baselines");
export const LIVE_CONFIG_PATH = join(LIVE_DIR, "config.json");

export function loadLiveScenarios(dir: string = LIVE_SCENARIOS_DIR): LiveScenario[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => liveScenarioSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

export function loadLiveConfig(path: string = LIVE_CONFIG_PATH): LiveConfig {
  return liveConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Steps whose default timeout must widen to the live turn timeout: a real
 * model turn takes seconds-to-minutes, unlike the scripted engine. */
const WAIT_STEP_KINDS = new Set<Step["kind"]>([
  "waitForTurns",
  "waitForNodeStatus",
  "waitForBusy",
  "waitForActivity",
  "waitForRoutineRun",
]);

type WaitStepKind =
  | "waitForTurns"
  | "waitForNodeStatus"
  | "waitForBusy"
  | "waitForActivity"
  | "waitForRoutineRun";
type WaitStep = Extract<Step, { kind: WaitStepKind }>;

function isWaitStep(step: Step): step is WaitStep {
  return WAIT_STEP_KINDS.has(step.kind as WaitStepKind);
}

/** Adapts a live scenario into the tier-1 scenario shape the world already
 * boots: empty scripted turns (the real model drives), wait steps widened
 * to the configured turn timeout, and only the assertion-shaped invariants
 * (botReplied is live-only and scored separately). */
export function toScenario(live: LiveScenario, config: LiveConfig): Scenario {
  return {
    id: live.id,
    title: live.title,
    behavior: live.behavior,
    world: "coordination",
    gates: [...new Set(live.steps.flatMap((step) => (step.kind === "writeGate" ? [step.gate] : [])))],
    bots: live.bots.map((bot) => ({ ...bot, turns: [] })),
    steps: live.steps.map((step) =>
      isWaitStep(step) && step.timeoutMs === undefined
        ? { ...step, timeoutMs: config.turnTimeoutMs }
        : step,
    ),
    assertions: live.invariants.filter((invariant): invariant is Assertion => invariant.kind !== "botReplied"),
  };
}

type ReplyInvariant = Extract<LiveInvariant, { kind: "botReplied" }>;

export function evaluateLiveChecks(live: LiveScenario, snapshot: WorldSnapshot): LiveCheckResult[] {
  const invariantChecks = evaluateAssertions(
    live.invariants.filter((invariant): invariant is Assertion => invariant.kind !== "botReplied"),
    snapshot,
  ).map((result) => ({ kind: result.assertion.kind, pass: result.pass, detail: result.detail }));
  const replyChecks: LiveCheckResult[] = live.invariants
    .filter((invariant): invariant is ReplyInvariant => invariant.kind === "botReplied")
    .map((invariant) => {
      const threadId =
        invariant.thread === "active"
          ? snapshot.activeThreads[invariant.bot]
          : snapshot.handoffs.find((node) => node.bot === invariant.bot)?.threadId;
      if (threadId === undefined) {
        return { kind: "botReplied", pass: false, detail: "no " + invariant.thread + " thread found for " + invariant.bot };
      }
      const messages = snapshot.threads[threadId] ?? [];
      const replied = messages.some((message) => message.role === "bot" && (message.text ?? "").trim() !== "");
      return replied
        ? { kind: "botReplied", pass: true, detail: "bot text reply present in the " + invariant.thread + " thread" }
        : { kind: "botReplied", pass: false, detail: "no bot text reply in the " + invariant.thread + " thread" };
    });
  return [...invariantChecks, ...replyChecks];
}

export function scenarioScore(checks: LiveCheckResult[]): number {
  if (checks.length === 0) return 0;
  return checks.filter((check) => check.pass).length / checks.length;
}

export function suiteScore(outcomes: LiveScenarioOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.reduce((total, outcome) => total + outcome.score, 0) / outcomes.length;
}

export interface ThresholdResult {
  pass: boolean;
  minScoreMet: boolean;
  /** Score drop from the recorded baseline, when one exists. */
  drift?: number;
}

export function applyThresholds(config: LiveConfig, score: number, baseline?: number): ThresholdResult {
  const minScoreMet = score >= config.minScore;
  const drift = baseline === undefined ? undefined : Math.max(0, baseline - score);
  return {
    pass: minScoreMet && (drift === undefined || drift <= config.maxDrift),
    minScoreMet,
    ...(drift === undefined ? {} : { drift }),
  };
}

export interface LiveSuiteReport {
  generatedAt: string;
  config: LiveConfig;
  score: number;
  thresholds: ThresholdResult;
  baselineScore?: number;
  baselineUpdated: boolean;
  outcomes: LiveScenarioOutcome[];
}

export function renderLiveMarkdown(report: LiveSuiteReport): string {
  const lines: string[] = [
    "# Live-model smoke report",
    "",
    "- Generated: " + report.generatedAt,
    "- Outcome: " + (report.thresholds.pass ? "PASS" : "FAIL"),
    "- Suite score: " + report.score + " (bar >= " + report.config.minScore + ")",
    report.baselineScore === undefined
      ? "- Baseline: none recorded (first run)"
      : "- Baseline score: " +
        report.baselineScore +
        " (max drift " +
        report.config.maxDrift +
        (report.thresholds.drift === undefined ? "" : ", drift " + report.thresholds.drift) +
        ")",
    "- Scenarios: " + report.outcomes.length + " (" + report.outcomes.filter((outcome) => outcome.score === 1).length + " scored 1.0)",
    "",
  ];
  for (const outcome of report.outcomes) {
    const ok = outcome.error === undefined && outcome.checks.every((check) => check.pass);
    lines.push("## " + (ok ? "PASS" : "FAIL") + " — " + outcome.id, "");
    lines.push(outcome.title, "", "Pinned behavior: " + outcome.behavior, "");
    lines.push("Score: " + outcome.score, "");
    if (outcome.error !== undefined) lines.push("Run error: " + outcome.error, "");
    lines.push("### Checks", "");
    for (const check of outcome.checks) {
      lines.push("- " + (check.pass ? "pass" : "FAIL") + " — " + check.kind + ": " + check.detail.replaceAll("\n", " "));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writeLiveReport(outDir: string, report: LiveSuiteReport, runId: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, runId + ".json");
  const markdown = join(outDir, runId + ".md");
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(markdown, renderLiveMarkdown(report) + "\n");
  return { json, markdown };
}
