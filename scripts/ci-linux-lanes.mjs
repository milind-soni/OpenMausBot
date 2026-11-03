import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Linux jobs' work as lanes of one machine: when the static job runs on a Boat VM (ci.yml, BOAT_CI), the vitest
// job's Linux shards, behavior evals and the Linux packaged server smoke run there as processes side by side, each
// lane its commands in order. ci-workflow.test.ts holds every command equal to the job step it stands for.

/** The vitest job's two steps for one Linux matrix entry, with the step's environment. */
export function vitestLane(entry, retryLog) {
  return {
    name: `vitest (ubuntu-latest, ${entry.part})`,
    env: { OMB_VITEST_RETRY_LOG: retryLog, OMB_VITEST_E2E: entry.e2e, OMB_VITEST_SUBSET: entry.files },
    commands: [
      `pnpm exec vitest run ${entry.files} --shard=${entry.shard}/${entry.shards} --reporter=default --reporter=github-actions`,
      ...(entry.node_tests ? ["pnpm broker:test && pnpm test:electron"] : []),
    ],
  };
}

export const EVALS_LANE = {
  name: "behavior evals (offline tiers 1-3)",
  env: {},
  commands: [
    "pnpm exec tsc -p evals/tsconfig.json",
    "pnpm exec vitest run --config evals/vitest.config.ts --reporter=default --reporter=github-actions",
    "pnpm eval",
    "pnpm eval --golden",
    `output="$(pnpm eval --live 2>&1)"
printf '%s\\n' "$output"
printf '%s\\n' "$output" | grep -q "live tier skipped"
`,
  ],
};

export const PACKAGED_SERVER_LANE = { name: "packaged server smoke (ubuntu-latest)", env: {}, commands: ["pnpm test:packaged-server"] };

/** Every lane of ci-scope's `linux_lanes` plan. */
export function lanesFor(plan, retryLog) {
  return [
    ...plan.vitest.map((entry) => vitestLane(entry, retryLog)),
    ...(plan.evals ? [EVALS_LANE] : []),
    ...(plan.packaged_server ? [PACKAGED_SERVER_LANE] : []),
  ];
}

const minutes = (ms) => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

/** Runs the lanes at once and prints each one's log whole when it ends. Resolves to the lanes that failed. */
export async function runLanes(lanes, { dir, timeoutMs, heartbeatMs = 60_000, log = console.log, summary = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const rows = [];
  const running = new Map();
  const finished = lanes.map((lane, index) => new Promise((done) => {
    const file = join(dir, `${index + 1}.log`);
    const out = openSync(file, "w");
    const child = spawn("bash", ["-eo", "pipefail", "-c", lane.commands.join("\n")], {
      env: { ...process.env, ...lane.env }, stdio: ["ignore", out, out], detached: true,
    });
    running.set(lane.name, child);
    // Each lane has its own process group, so a timeout or a cancelled job ends its servers and fake CLIs too.
    const timer = setTimeout(() => {
      log(`::error title=${lane.name}::still running after ${minutes(timeoutMs)}, so it was stopped`);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      running.delete(lane.name);
      const took = minutes(Date.now() - started);
      const verdict = code === 0 ? "passed" : `FAILED (${signal ?? `exit ${code}`})`;
      log(`::group::${lane.name}: ${verdict} after ${took}`);
      log(readFileSync(file, "utf8").trimEnd());
      log("::endgroup::");
      if (code !== 0) log(`::error title=${lane.name}::${verdict}; its log is in the group of that name`);
      rows.push({ name: lane.name, verdict, took });
      done(code === 0 ? null : lane.name);
    });
  }));
  const heartbeat = setInterval(() => log(`${minutes(Date.now() - started)}: still running ${[...running.keys()].join(", ")}`), heartbeatMs);
  const stop = () => { for (const child of running.values()) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const failed = (await Promise.all(finished)).filter(Boolean);
  clearInterval(heartbeat);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  summary(["| Linux lane | Result | Time |", "|---|---|---|", ...rows.map((row) => `| ${row.name} | ${row.verdict} | ${row.took} |`), ""].join("\n"));
  return failed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(process.env.OMB_CI_LINUX_LANES ?? "");
  const temp = process.env.RUNNER_TEMP ?? "/tmp";
  const failed = await runLanes(lanesFor(plan, join(temp, "vitest-retries.jsonl")), {
    dir: join(temp, "linux-lanes"),
    timeoutMs: Number(process.env.OMB_CI_LANE_TIMEOUT_MINUTES ?? 30) * 60_000,
    summary: (markdown) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown),
  });
  if (failed.length) {
    console.log(`\n${failed.length} Linux lane(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}
