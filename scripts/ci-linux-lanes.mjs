import { spawn } from "node:child_process";
import { appendFileSync, chownSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
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

/** Puts a lane in a network namespace of its own with only its loopback up, so no two lanes' servers meet on a port
 * or an abstract socket, then runs it as the user who started the job with every capability dropped. Making the
 * namespace takes root: an unprivileged user namespace shows root's files as nobody's, and path-safety checks in the
 * suite then refuse /tmp and /usr. */
export const ISOLATE = ["unshare", "--net", "--", "sh", "-c",
  'ip link set lo up && exec setpriv --reuid="$1" --regid="$2" --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -eo pipefail -c "$3"',
  "lane"];

/** How a lane starts. Isolated, it runs as `user` ({ uid, gid }) with its own home, temporary and runtime folders under
 * `dir`, which is under /tmp: tests hold scratch homes and install roots to /tmp. */
export function laneCommand(lane, { isolate, dir, user }) {
  const script = lane.commands.join("\n");
  if (!isolate) return { file: "bash", args: ["-eo", "pipefail", "-c", script], env: lane.env };
  return {
    file: ISOLATE[0],
    args: [...ISOLATE.slice(1), String(user.uid), String(user.gid), script],
    env: { ...lane.env, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), XDG_RUNTIME_DIR: join(dir, "run") },
  };
}

/** What stops an isolated lane from holding on this machine, or null: it must not reach a port listening outside it,
 * must bind that same port itself, run as `user` without capabilities, and use its own temporary folder. */
export async function isolationProblem(user, { dir }) {
  const outside = createServer();
  await new Promise((done) => outside.listen(0, "127.0.0.1", done));
  const { port } = outside.address();
  const lines = [];
  try {
    const failed = await runLanes([{ name: "isolation check", env: {}, commands: [
      `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(3)).on('error', () => process.exit(0))"`,
      `node -e "require('net').createServer().listen(${port}, '127.0.0.1', () => process.exit(0))"`,
      `test "$(id -u)" = "${user.uid}"`,
      "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
      `test "$(node -p "require('os').tmpdir()")" = "$TMPDIR"`,
    ] }], { dir, timeoutMs: 60_000, isolate: true, user, log: (line) => lines.push(line) });
    return failed.length ? lines.join("\n") : null;
  } finally {
    outside.close();
  }
}

const minutes = (ms) => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

/** Runs the lanes at once and prints each one's log whole when it ends. Resolves to the lanes that failed. */
export async function runLanes(lanes, { dir, timeoutMs, isolate = false, user, heartbeatMs = 60_000, log = console.log, summary = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const rows = [];
  const running = new Map();
  const finished = lanes.map((lane, index) => new Promise((done) => {
    const file = join(dir, `${index + 1}.log`);
    const own = isolate ? mkdtempSync(join("/tmp", `omb-lane-${index + 1}-`)) : join(dir, String(index + 1));
    for (const folder of ["", "home", "tmp", "run"]) {
      mkdirSync(join(own, folder), { recursive: true, mode: 0o700 });
      if (isolate) chownSync(join(own, folder), user.uid, user.gid);
    }
    const out = openSync(file, "w");
    const command = laneCommand(lane, { isolate, dir: own, user });
    const child = spawn(command.file, command.args, {
      env: { ...process.env, ...command.env }, stdio: ["ignore", out, out], detached: true,
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
  const isolate = process.env.OMB_CI_ISOLATE_LANES === "1";
  const user = { uid: Number(process.env.SUDO_UID), gid: Number(process.env.SUDO_GID) };
  if (isolate) {
    const problem = process.getuid?.() !== 0 || !(user.uid > 0) || !(user.gid > 0)
      ? "isolating the lanes takes root and the user who started the job: run this through sudo"
      : await isolationProblem(user, { dir: join(temp, "linux-lanes", "check") });
    if (problem) {
      console.log(`::error title=Linux lanes::a lane cannot get a network namespace of its own here\n${problem}`);
      process.exit(1);
    }
  }
  const failed = await runLanes(lanesFor(plan, join(temp, "vitest-retries.jsonl")), {
    dir: join(temp, "linux-lanes"),
    isolate,
    user,
    timeoutMs: Number(process.env.OMB_CI_LANE_TIMEOUT_MINUTES ?? 30) * 60_000,
    summary: (markdown) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown),
  });
  if (failed.length) {
    console.log(`\n${failed.length} Linux lane(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}
