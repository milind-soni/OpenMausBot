import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createIndependentLocalFixtureAdapter, runAllScenarios } from "../benchmarks/agent-centipede/index.ts";

type SoakStatus = "running" | "passed" | "failed" | "interrupted";

interface SoakProgress {
  readonly schemaVersion: 1;
  readonly mode: "independent-local-fixture-wall-clock-soak";
  readonly status: SoakStatus;
  readonly processId: number;
  readonly startedAt: string;
  readonly expectedEndAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
  readonly cycles: number;
  readonly scenarioRuns: number;
  readonly retries: number;
  readonly failedRuns: number;
  readonly productionWrites: 0;
  readonly externalActions: 0;
  readonly lastError?: string;
}

function valueArg(name: string): string | undefined {
  return process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function finiteNumber(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

async function writeProgress(file: string, progress: SoakProgress): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const durationSeconds = finiteNumber(valueArg("--duration-seconds"), 7_200, "duration-seconds");
const intervalSeconds = finiteNumber(valueArg("--interval-seconds"), 60, "interval-seconds");
if (intervalSeconds > 60) throw new Error("interval-seconds must be 60 or less so health checkpoints stay fresh");
const output = resolve(valueArg("--output") ?? "artifacts/agent-centipede-benchmark/two-hour-soak/progress.json");
const startedAtMs = Date.now();
const expectedEndAtMs = startedAtMs + durationSeconds * 1_000;
let progress: SoakProgress = {
  schemaVersion: 1,
  mode: "independent-local-fixture-wall-clock-soak",
  status: "running",
  processId: process.pid,
  startedAt: new Date(startedAtMs).toISOString(),
  expectedEndAt: new Date(expectedEndAtMs).toISOString(),
  updatedAt: new Date(startedAtMs).toISOString(),
  durationSeconds,
  intervalSeconds,
  cycles: 0,
  scenarioRuns: 0,
  retries: 0,
  failedRuns: 0,
  productionWrites: 0,
  externalActions: 0,
};

async function mark(status: SoakStatus, errorMessage?: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const base = {
    ...progress,
    status,
    updatedAt,
  };
  if (status === "running") progress = base;
  else if (errorMessage === undefined) progress = { ...base, completedAt: updatedAt };
  else progress = { ...base, completedAt: updatedAt, lastError: errorMessage };
  await writeProgress(output, progress);
}

let interruptHandled = false;
async function handleInterrupt(): Promise<void> {
  if (interruptHandled) return;
  interruptHandled = true;
  await mark("interrupted", "process interrupted before the wall-clock duration completed");
  process.exitCode = 130;
}
process.once("SIGINT", () => { void handleInterrupt(); });
process.once("SIGTERM", () => { void handleInterrupt(); });

try {
  await mark("running");
  while (!interruptHandled && Date.now() < expectedEndAtMs) {
    const results = await runAllScenarios({ adapterFactory: () => createIndependentLocalFixtureAdapter() });
    const failures = results.filter((result) => !result.passed || !result.evidence.e2eVerified || result.metrics.safetyViolations > 0);
    progress = {
      ...progress,
      cycles: progress.cycles + 1,
      scenarioRuns: progress.scenarioRuns + results.length,
      retries: progress.retries + results.reduce((sum, result) => sum + result.metrics.retries, 0),
      failedRuns: progress.failedRuns + failures.length,
    };
    if (failures.length > 0) throw new Error(`fault soak failed: ${failures.map((result) => result.scenario.id).join(", ")}`);
    await mark("running");
    const remainingMs = expectedEndAtMs - Date.now();
    if (remainingMs > 0) await delay(Math.min(intervalSeconds * 1_000, remainingMs));
  }
  if (!interruptHandled) await mark("passed");
} catch (error) {
  await mark("failed", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

try {
  const receipt = await readFile(output, "utf8");
  process.stdout.write(receipt);
} catch {
  // The process exit code still reports a write failure if no receipt exists.
}
