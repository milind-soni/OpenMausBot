import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  assertionSchema,
  fixtureSkillSchema,
  scenarioBotSchema,
  scenarioSchema,
  scriptedTurnSchema,
  type Scenario,
} from "../types.ts";
import { scoreSkillBench } from "../scorers/skill-bench.ts";
import { runScenario } from "./run-scenario.ts";

/** The skill bench (alpha): runs one fixture skill's test prompts twice
 * each — with the skill installed as a user skill and without it — through
 * the same scripted-provider machinery as tier 1, then scores the contrast.
 * It evaluates the harness seam (skill selection, prompt delivery) against
 * scripted follower behavior; real models are out of scope. */

const BENCHES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skill-bench", "fixtures");
export const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "runs");

export const skillBenchSchema = z.object({
  id: z.string(),
  title: z.string(),
  behavior: z.string(),
  skill: fixtureSkillSchema,
  /** The bot the skill is tested on. Chief/section fields follow the
   * scenario bot schema so dispatch-bearing skills work out of the box. */
  subject: scenarioBotSchema.omit({ turns: true }),
  /** Bots the with-skill arm may dispatch to; they replay their scripted
   * turns only when something actually dispatches to them. */
  targets: z.array(scenarioBotSchema).default([]),
  /** A fixture must measure something: at least one prompt, at least one
   * assertion per prompt, and unique prompt ids — duplicate ids would
   * fold two prompts' runs into one scored bucket, and empty arrays
   * would let a run that checked nothing report success. */
  prompts: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      /** Checked against BOTH arms' frozen evidence; the delta is the point. */
      assertions: z.array(assertionSchema).min(1),
      withSkill: z.object({ turns: z.array(scriptedTurnSchema) }),
      withoutSkill: z.object({ turns: z.array(scriptedTurnSchema) }),
    }),
  )
    .min(1)
    .refine((prompts) => new Set(prompts.map((prompt) => prompt.id)).size === prompts.length, {
      message: "prompt ids must be unique",
    }),
  replicates: z.number().int().min(1).default(1),
});

export type SkillBenchFixture = z.infer<typeof skillBenchSchema>;
export type SkillBenchArm = "with" | "without";

export interface SkillBenchArmRun {
  promptId: string;
  arm: SkillBenchArm;
  replicate: number;
  result: import("../scorers/snapshot.ts").ScenarioResult;
}

export interface SkillBenchArmSummary {
  runs: number;
  passed: number;
  total: number;
  passRate: number;
  durationMeanMs: number;
  durationStddevMs: number;
  estimatedTokensMean: number;
  estimatedTokensStddev: number;
}

export interface SkillBenchAssertionDelta {
  promptId: string;
  index: number;
  label: string;
  withPasses: number;
  withoutPasses: number;
  withRuns: number;
  withoutRuns: number;
  withRate: number;
  withoutRate: number;
  delta: number;
  nonDiscriminating: boolean;
  highVariance: boolean;
}

export interface SkillBenchPromptResult {
  promptId: string;
  text: string;
  runs: Array<{
    arm: SkillBenchArm;
    replicate: number;
    pass: boolean;
    durationMs: number;
    estimatedTokens: number;
    failedAssertions: string[];
    error?: string;
  }>;
}

/** The alpha report: pass rates per arm, time and token estimates with
 * spread, the per-assertion delta table, and the two flags a fixture
 * author needs before trusting a contrast (non-discriminating assertions,
 * high-variance verdicts). */
export interface SkillBenchReport {
  fixtureId: string;
  title: string;
  behavior: string;
  generatedAt: string;
  replicates: number;
  prompts: SkillBenchPromptResult[];
  assertions: SkillBenchAssertionDelta[];
  summary: {
    withSkill: SkillBenchArmSummary;
    withoutSkill: SkillBenchArmSummary;
    flags: { nonDiscriminating: number; highVariance: number };
  };
  errors: string[];
}

export function loadSkillBenches(): SkillBenchFixture[] {
  return readdirSync(BENCHES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => skillBenchSchema.parse(JSON.parse(readFileSync(join(BENCHES_DIR, name), "utf8"))));
}

/** Target keys this prompt's with-arm actually dispatches to: the scripted
 * steps' coordinate_bots calls name their targets as "@key" in bot_ids, so
 * the bench waits only where the prompt's own script sends work. */
function dispatchedTargetKeys(prompt: SkillBenchFixture["prompts"][number]): Set<string> {
  const ids = prompt.withSkill.turns.flatMap((turn) => turn.steps ?? []).flatMap((step) => {
    const value = step.arguments.bot_ids;
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : [];
  });
  return new Set(ids.map((id) => id.replace(/^@/, "")));
}

export function buildArmScenario(
  bench: SkillBenchFixture,
  prompt: SkillBenchFixture["prompts"][number],
  arm: SkillBenchArm,
  replicate: number,
): Scenario {
  const turns = arm === "with" ? prompt.withSkill.turns : prompt.withoutSkill.turns;
  const dispatchedKeys = dispatchedTargetKeys(prompt);
  return scenarioSchema.parse({
    id: bench.id + "/" + prompt.id + "/" + arm + "#" + replicate,
    title: bench.title,
    behavior: bench.behavior,
    world: "coordination",
    gates: [],
    bots: [{ ...bench.subject, turns }, ...bench.targets],
    steps: [
      // Only the with-arm installs the skill; that difference is the whole
      // treatment under test.
      ...(arm === "with" ? [{ kind: "installSkill", skill: bench.skill }] : []),
      { kind: "send", bot: bench.subject.key, text: prompt.text },
      { kind: "waitForTurns", bot: bench.subject.key, count: turns.length, timeoutMs: 20_000 },
      // Targets only turn when this prompt's with-arm actually dispatched
      // to them. The scripted steps carry the dispatches as coordinate_bots
      // bot_ids ("@key"), so the waits follow the prompt's own script
      // rather than assuming every configured target turns — a with-arm
      // that correctly dispatches to nobody proceeds straight to its
      // assertions instead of timing out.
      ...(arm === "with"
        ? bench.targets
            .filter((target) => target.turns.length > 0 && dispatchedKeys.has(target.key))
            .map((target) => ({ kind: "waitForTurns", bot: target.key, count: target.turns.length, timeoutMs: 20_000 }))
        : []),
    ],
    assertions: prompt.assertions,
  });
}

export async function runSkillBench(bench: SkillBenchFixture, replicates = bench.replicates): Promise<SkillBenchReport> {
  const runs: SkillBenchArmRun[] = [];
  for (const prompt of bench.prompts) {
    for (const arm of ["with", "without"] as const) {
      for (let replicate = 1; replicate <= replicates; replicate += 1) {
        const result = await runScenario(buildArmScenario(bench, prompt, arm, replicate));
        runs.push({ promptId: prompt.id, arm, replicate, result });
      }
    }
  }
  // Score the fixture the override produced: with --replicates the report
  // must publish the count that ran, not the fixture's default.
  return scoreSkillBench({ ...bench, replicates }, runs);
}

const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

export function renderSkillBenchMarkdown(report: SkillBenchReport): string {
  const arm = (label: string, summary: SkillBenchArmSummary): string =>
    "- " + label + ": pass rate " + Math.round(summary.passRate * 100) + "% (" + summary.passed + "/" + summary.total +
    " assertions), time " + round(summary.durationMeanMs / 1000) + "s ± " + round(summary.durationStddevMs / 1000) +
    "s, tokens " + round(summary.estimatedTokensMean) + " ± " + round(summary.estimatedTokensStddev) + " (estimated, chars/4)";
  const lines: string[] = [
    "# Skill bench report (alpha)",
    "",
    "- Fixture: " + report.fixtureId + " — " + report.title,
    "- Generated: " + report.generatedAt + " (" + report.replicates + " replicate(s) per arm)",
    "- Hypothesis: " + report.behavior,
    "- Tokens are estimated (chars/4 over evidence turns); the scripted provider makes no API calls.",
    "",
    "## Summary",
    "",
    arm("With skill", report.summary.withSkill),
    arm("Without skill", report.summary.withoutSkill),
    "- Flags: " + report.summary.flags.nonDiscriminating + " non-discriminating assertion(s), " +
      report.summary.flags.highVariance + " high-variance assertion(s)",
    "",
    "## Delta per assertion",
    "",
  ];
  for (const assertion of report.assertions) {
    const tag = assertion.highVariance ? "high-variance" : assertion.nonDiscriminating ? "non-discriminating" : "discriminating";
    lines.push(
      "- [" + tag + "] " + (assertion.delta >= 0 ? "+" : "") + round(assertion.delta, 2) + " " + assertion.promptId + " " + assertion.label +
        " (with " + assertion.withPasses + "/" + assertion.withRuns + ", without " + assertion.withoutPasses + "/" + assertion.withoutRuns + ")",
    );
  }
  lines.push("", "## Prompts", "");
  for (const prompt of report.prompts) {
    lines.push("### " + prompt.promptId, "", "> " + prompt.text, "");
    for (const run of prompt.runs) {
      lines.push(
        "- " + run.arm + "-skill #" + run.replicate + ": " + (run.pass ? "PASS" : "FAIL") +
          " in " + round(run.durationMs / 1000) + "s, ~" + run.estimatedTokens + " tokens" +
          (run.error === undefined ? "" : " — run error: " + run.error),
      );
      for (const failure of run.failedAssertions) lines.push("  - " + failure);
    }
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push("## Run errors", "", ...report.errors.map((error) => "- " + error), "");
  }
  return lines.join("\n");
}

export function writeSkillBenchReport(outDir: string, report: SkillBenchReport, runId: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, runId + ".json");
  const markdown = join(outDir, runId + ".md");
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(markdown, renderSkillBenchMarkdown(report) + "\n");
  return { json, markdown };
}

/** Parsed CLI state for the bench runner. Kept pure so the validation
 * contract — every flag consumes a non-flag value, unknown options and
 * positional arguments are rejected, and --replicates must be a positive
 * integer — is testable without spawning the runner. */
export interface SkillBenchCliOptions {
  wanted: Set<string>;
  replicates: number | undefined;
  outDir: string;
}

export type ParsedSkillBenchArgs = { ok: true; options: SkillBenchCliOptions } | { ok: false; error: string };

export function parseSkillBenchArgs(args: string[]): ParsedSkillBenchArgs {
  const wanted = new Set<string>();
  let replicates: number | undefined;
  let outDir = DEFAULT_OUT;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--fixture" || flag === "--replicates" || flag === "--out") {
      const value = args[index + 1];
      // A trailing flag is a missing operand, not a value: consuming it
      // would silently reroute the run (e.g. --out --fixture my-bench).
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: flag + " requires a value" };
      }
      if (flag === "--fixture") wanted.add(value);
      else if (flag === "--replicates") replicates = Number(value);
      else outDir = value;
      index += 1;
      continue;
    }
    // A typo like --replicate must fail loudly, never fall back to the
    // fixture defaults and report a run the user did not ask for.
    if (flag.startsWith("--")) return { ok: false, error: "unknown option " + flag };
    return { ok: false, error: "unexpected argument " + flag };
  }
  if (replicates !== undefined && (!Number.isInteger(replicates) || replicates < 1)) {
    return { ok: false, error: "--replicates must be a positive integer" };
  }
  return { ok: true, options: { wanted, replicates, outDir } };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node --experimental-strip-types evals/runners/run-skill-bench.ts [--fixture <id>]... [--replicates <n>] [--out <dir>]");
    return 0;
  }
  const parsed = parseSkillBenchArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { wanted, replicates, outDir } = parsed.options;
  const all = loadSkillBenches();
  const available = new Set(all.map((bench) => bench.id));
  const missing = [...wanted].filter((id) => !available.has(id));
  if (missing.length > 0) {
    console.error("unknown fixtures: " + missing.join(", "));
    return 2;
  }
  const selected = wanted.size === 0 ? all : all.filter((bench) => wanted.has(bench.id));
  if (selected.length === 0) {
    console.error("no fixtures matched " + [...wanted].join(", "));
    return 2;
  }
  let errors = 0;
  for (const bench of selected) {
    console.log("benching " + bench.id + " (" + bench.prompts.length + " prompts x 2 arms x " + (replicates ?? bench.replicates) + " replicate(s))...");
    const report = await runSkillBench(bench, replicates);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const written = writeSkillBenchReport(outDir, report, "skill-bench-" + bench.id + "-" + stamp);
    console.log("  with-skill pass rate " + Math.round(report.summary.withSkill.passRate * 100) + "%, without " + Math.round(report.summary.withoutSkill.passRate * 100) + "%");
    console.log("  flags: " + report.summary.flags.nonDiscriminating + " non-discriminating, " + report.summary.flags.highVariance + " high-variance");
    console.log("  report: " + written.markdown);
    errors += report.errors.length;
  }
  // A failing without-skill arm is expected data, not a bench error; only
  // runs that could not complete fail the command.
  return errors === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
