import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Step } from "../types.ts";
import type { WorldContext } from "../runners/base-world.ts";
import type { WorldSnapshot } from "../scorers/snapshot.ts";
import { LiveWorld } from "./live-world.ts";
import { loadJudgePrompt, parseJudgeVerdict, renderJudgePrompt } from "./judge/judge.ts";
import {
  LIVE_BASELINES_DIR,
  applyThresholds,
  evaluateLiveChecks,
  loadLiveConfig,
  loadLiveScenarios,
  scenarioScore,
  suiteScore,
  toScenario,
  writeLiveReport,
  type LiveSuiteReport,
} from "./live-suite.ts";
import {
  liveInstanceSchema,
  type LiveCheckResult,
  type LiveConfig,
  type LiveInstance,
  type LiveScenario,
  type LiveScenarioOutcome,
} from "./types.ts";
/** Tier 3, the opt-in runner. Everything that could touch a real model sits
 * behind the OMB_EVAL_LIVE=1 gate: with the gate closed the entrypoint
 * prints one skip line and exits 0, so CI and local runs stay offline by
 * default no matter how the eval task is invoked. */

const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "runs");
const BASELINE_PATH = join(LIVE_BASELINES_DIR, "live-suite.json");

export function loadLiveInstance(env: Record<string, string | undefined>): LiveInstance {
  const inline = env.OMB_EVAL_LIVE_INSTANCE;
  if (inline !== undefined && inline.trim() !== "") {
    return liveInstanceSchema.parse(JSON.parse(inline));
  }
  const path = env.OMB_EVAL_LIVE_CONFIG;
  if (path !== undefined && path.trim() !== "") {
    return liveInstanceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  throw new Error(
    "live tier is gated on (OMB_EVAL_LIVE=1) but no engine instance is configured; set OMB_EVAL_LIVE_INSTANCE (inline JSON) or OMB_EVAL_LIVE_CONFIG (path to instance JSON)",
  );
}

function passEnvNames(env: Record<string, string | undefined>): string[] {
  return (env.OMB_EVAL_LIVE_PASS_ENV ?? "")
    .split(/[:,]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function lastBotText(snapshot: WorldSnapshot): string | undefined {
  for (const threadId of Object.values(snapshot.activeThreads).reverse()) {
    const reply = [...(snapshot.threads[threadId] ?? [])]
      .reverse()
      .find((message) => message.role === "bot" && (message.text ?? "").trim() !== "");
    if (reply !== undefined) return reply.text;
  }
  for (const node of [...snapshot.handoffs].reverse()) {
    const reply = [...(snapshot.threads[node.threadId] ?? [])]
      .reverse()
      .find((message) => message.role === "bot" && (message.text ?? "").trim() !== "");
    if (reply !== undefined) return reply.text;
  }
  return undefined;
}

async function runJudge(
  world: LiveWorld,
  ctx: WorldContext,
  live: LiveScenario,
  config: LiveConfig,
  scenarioSnapshot: WorldSnapshot,
  promptVersion: string,
): Promise<LiveCheckResult> {
  const prompt = loadJudgePrompt(promptVersion);
  const sendStep = [...live.steps]
    .reverse()
    .find((step): step is Extract<Step, { kind: "send" }> => step.kind === "send");
  const task = sendStep?.text ?? live.behavior;
  const reply = lastBotText(scenarioSnapshot);
  if (reply === undefined) {
    return { kind: "judge:" + prompt.version, pass: false, detail: "scenario produced no bot reply to judge" };
  }
  await world.createBot("judge", "Judge");
  const attempts = config.maxJudgeRetries + 1;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await world.runStep({ kind: "send", bot: "judge", text: renderJudgePrompt(prompt.text, task, reply) }, ctx);
    // State-based wait: wait for THIS send's turn to appear in the judge's
    // thread-derived evidence, then read the reply it produced.
    await world.runStep({ kind: "waitForTurns", bot: "judge", count: attempt, timeoutMs: config.judgeTimeoutMs }, ctx);
    const snapshot = await world.snapshot(ctx);
    const judgeThreadId = snapshot.activeThreads["judge"];
    const judgeReply = [...(snapshot.threads[judgeThreadId] ?? [])]
      .reverse()
      .find((message) => message.role === "bot" && (message.text ?? "").trim() !== "")?.text ?? "";
    try {
      const verdict = parseJudgeVerdict(judgeReply);
      return {
        kind: "judge:" + prompt.version,
        pass: verdict.pass,
        detail: "judge score " + verdict.score + (verdict.reasons.length > 0 ? " — " + verdict.reasons.join("; ") : ""),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    kind: "judge:" + prompt.version,
    pass: false,
    detail: "judge verdict unparseable after " + attempts + " attempt(s): " + lastError,
  };
}

export async function runLiveMain(args: string[]): Promise<number> {
  if (process.env.OMB_EVAL_LIVE !== "1") {
    console.log(
      "live tier skipped: offline by default; set OMB_EVAL_LIVE=1 plus OMB_EVAL_LIVE_INSTANCE (or OMB_EVAL_LIVE_CONFIG) to run real-model smoke evals",
    );
    return 0;
  }
  const wanted = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") wanted.add(args[index + 1] ?? "");
    if (args[index] === "--out") index += 1;
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex === -1 ? DEFAULT_OUT : (args[outIndex + 1] ?? DEFAULT_OUT);
  const updateBaseline = args.includes("--update-baseline");

  let instance: LiveInstance;
  try {
    instance = loadLiveInstance(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const config = loadLiveConfig();
  const all = loadLiveScenarios();
  const unknown = [...wanted].filter((id) => !all.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    console.error("unknown live scenarios: " + unknown.join(", "));
    return 2;
  }
  const selected = wanted.size === 0 ? all : all.filter((scenario) => wanted.has(scenario.id));
  if (selected.length === 0) {
    console.error("no live scenarios found under evals/live/scenarios");
    return 2;
  }

  const outcomes: LiveScenarioOutcome[] = [];
  for (const live of selected) {    console.log("running live " + live.id + "...");
    const world = new LiveWorld(instance, passEnvNames(process.env));
    const ctx: WorldContext = { sends: [], observations: {} };
    let checks: LiveCheckResult[] = [];
    let error: string | undefined;
    try {
      const scenario = toScenario(live, config);
      await world.boot(scenario);
      for (const step of scenario.steps) {
        await world.runStep(step, ctx);
      }
      const snapshot = await world.snapshot(ctx);
      checks = evaluateLiveChecks(live, snapshot);
      if (live.judged !== undefined) {
        checks.push(await runJudge(world, ctx, live, config, snapshot, live.judged.prompt));
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      await world.close().catch(() => undefined);
    }
    const outcome: LiveScenarioOutcome = {
      id: live.id,
      title: live.title,
      behavior: live.behavior,
      checks,
      score: error === undefined ? scenarioScore(checks) : 0,
      ...(error === undefined ? {} : { error }),
    };
    outcomes.push(outcome);
    console.log(
      "  " + (outcome.error === undefined && checks.every((check) => check.pass) ? "PASS" : "FAIL") + " score " + outcome.score,
    );
    if (error !== undefined) console.log("    run error: " + error);
    for (const check of checks) {
      if (!check.pass) console.log("    check failed: " + check.kind + " — " + check.detail.replaceAll("\n", " "));
    }
  }

  const score = suiteScore(outcomes);
  const baselineScore = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { score: number }).score
    : undefined;
  const thresholds = applyThresholds(config, score, baselineScore);
  let baselineUpdated = false;
  if (updateBaseline) {
    mkdirSync(LIVE_BASELINES_DIR, { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify({ score, generatedAt: new Date().toISOString() }, null, 2) + "\n");
    baselineUpdated = true;
    console.log("live baseline updated: " + BASELINE_PATH);
  }
  const report: LiveSuiteReport = {
    generatedAt: new Date().toISOString(),
    config,
    score,
    thresholds,
    ...(baselineScore === undefined ? {} : { baselineScore }),
    baselineUpdated,
    outcomes,
  };
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const written = writeLiveReport(outDir, report, "live-" + stamp);
  console.log("report: " + written.markdown);
  console.log(
    "live suite score " +
      score +
      " (bar >= " +
      config.minScore +
      (thresholds.drift === undefined ? "" : ", drift " + thresholds.drift + " <= " + config.maxDrift) +
      ")",
  );
  const scenariosPass = outcomes.every(
    (outcome) => outcome.error === undefined && outcome.checks.every((check) => check.pass),
  );
  return scenariosPass && thresholds.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLiveMain(process.argv.slice(2));
}
