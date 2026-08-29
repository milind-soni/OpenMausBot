import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(process.cwd());
const output = resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ?? "artifacts/agent-centipede-benchmark/four-worker-production-routing.json");
await mkdir(resolve(output, ".."), { recursive: true });
const runRoot = resolve(join(output, "..", `four-worker-run-${Date.now()}`));
await mkdir(runRoot, { recursive: true });
const dataRoot = join(runRoot, "data");
const homeRoot = join(runRoot, "home");
const timingLog = join(runRoot, "worker-timing.ndjson");
const workerJobsPath = join(dataRoot, "worker-jobs.json");
await mkdir(dataRoot, { recursive: true });
await mkdir(homeRoot, { recursive: true });
await writeFile(timingLog, "", "utf8");

const portProbe = createServer();
await new Promise((accept, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", accept);
});
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("benchmark port probe failed");
const port = address.port;
await new Promise((accept) => portProbe.close(accept));
const origin = `http://127.0.0.1:${port}`;
const commsToken = "benchmark-local-comms-token";
const fakeCli = `"${process.execPath}" "${join(repoRoot, "benchmarks", "agent-centipede", "parallel-fake-acp.mjs")}"`;
await writeFile(join(dataRoot, "config.json"), `${JSON.stringify({
  instances: {
    benchmark: {
      driver: "cursorAgent",
      displayName: "Production-route fixture",
      environment: { FAKE_ACP_AUTH: "1", FAKE_ACP_EVENT_DUMP: timingLog },
      config: { cli: fakeCli },
    },
  },
}, null, 2)}\n`, "utf8");

const child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
  cwd: repoRoot,
  env: {
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    ComSpec: process.env.ComSpec ?? "",
    PATHEXT: process.env.PATHEXT ?? "",
    PATH: process.env.PATH ?? "",
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    APPDATA: join(homeRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeRoot, "AppData", "Local"),
    TMP: join(runRoot, "tmp"),
    TEMP: join(runRoot, "tmp"),
    OMB_DATA_DIR: dataRoot,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_COMMS_TOKEN: commsToken,
    OMB_WORKER_CONCURRENCY: "4",
  },
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });

const api = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${commsToken}`, "content-type": "application/json", ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
const waitFor = async (label, fn, timeoutMs = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server exited while waiting for ${label}: ${child.exitCode}`);
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const stop = async () => {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((accept) => {
    child.once("close", accept);
    setTimeout(accept, 5_000).unref();
  });
};

const startedAt = new Date().toISOString();
let receipt;
try {
  await waitFor("production server", async () => (await fetch(`${origin}/api/bots`)).ok, 90_000);
  const initial = await api("/api/bots");
  const seed = initial.bots?.[0];
  if (!seed?.id || !seed.threadId) throw new Error("server did not seed a coordinator bot");
  const patched = await api(`/api/bots/${encodeURIComponent(seed.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "Production Route Coordinator",
      agentGrants: [{ capability: "agents.coordinate" }],
      modelSelection: { instanceId: "benchmark", model: "auto" },
    }),
  });
  const tasks = ["alpha", "bravo", "charlie", "delta"].map((label) => ({ label, instructions: `Return the local fixture receipt for ${label}.` }));
  const dispatch = await api("/api/internal/parallelize-work", {
    method: "POST",
    body: JSON.stringify({ fromBotId: patched.bot.id, fromThreadId: patched.bot.threadId, label: "exact-four-production-routing", requestKey: `four-worker-${Date.now()}`, tasks }),
  });
  if (dispatch.accepted !== 4 || dispatch.jobs?.length !== 4) throw new Error(`expected exactly four accepted workers, got ${JSON.stringify(dispatch)}`);
  const done = await waitFor("four worker completion", async () => {
    const jobs = JSON.parse(await readFile(workerJobsPath, "utf8"));
    const batch = jobs.filter((job) => job.batchId === dispatch.workId);
    return batch.length === 4 && batch.every((job) => job.status === "completed")
      ? { counts: { total: batch.length, completed: batch.filter((job) => job.status === "completed").length }, jobs: batch }
      : null;
  }, 60_000);
  const cost = await api(`/api/work/costs?taskId=${encodeURIComponent(patched.bot.threadId)}`);
  const events = (await readFile(timingLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const points = events.flatMap((event) => [{ at: event.at, delta: event.event === "start" ? 1 : -1 }]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maxConcurrent = 0;
  for (const point of points) { active += point.delta; maxConcurrent = Math.max(maxConcurrent, active); }
  if (maxConcurrent !== 4) throw new Error(`expected max concurrency 4, observed ${maxConcurrent}`);
  receipt = {
    schemaVersion: 1,
    status: "passed",
    command: "node scripts/agent-centipede-four-worker.mjs",
    startedAt,
    completedAt: new Date().toISOString(),
    route: "/api/internal/parallelize-work",
    acceptedWorkers: dispatch.accepted,
    completedWorkers: done.counts.completed,
    maxConcurrent,
    jobStatuses: done.jobs.map((job) => ({ id: job.id, label: job.label, status: job.status })),
    costSummary: cost.summary,
    productionWrites: 0,
    externalActions: 0,
    timingEvidence: timingLog,
  };
} catch (error) {
  receipt = {
    schemaVersion: 1,
    status: "failed",
    command: "node scripts/agent-centipede-four-worker.mjs",
    startedAt,
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    serverOutput: serverOutput.slice(-4_000),
    productionWrites: 0,
    externalActions: 0,
  };
  process.exitCode = 1;
} finally {
  await stop();
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
