#!/usr/bin/env node
// The bundled server's start alone, on a fixture folder only: from the fork to its "listening" line and to its first
// answered request, on the Node that Electron ships (ELECTRON_RUN_AS_NODE) or on this one. Prints one JSON object.
//   pnpm build:server
//   node scripts/bench-server-start.mjs --data /tmp/openmausbot-bench-X/data [--app CHECKOUT] [--runs 15] [--source]
//     [--node] [--no-cache] [--cpu-prof DIR] [--label NAME]
// --source: server/index.ts under --experimental-strip-types instead of the bundle. --node: this Node, not Electron's.
// --no-cache: no compile cache (a first launch after an update). --cpu-prof: one V8 profile per run into DIR.
// Not measured: the desktop parent's part (lease, keys, the private connection); the server runs as a plain local one.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { Agent } from "node:http";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  data: { type: "string" }, app: { type: "string", default: join(HERE, "..") }, runs: { type: "string", default: "15" }, source: { type: "boolean", default: false },
  node: { type: "boolean", default: false }, "no-cache": { type: "boolean", default: false }, "cpu-prof": { type: "string" }, label: { type: "string", default: "server-start" },
  port: { type: "string", default: "38811" },
} });
if (!values.data || !values.data.includes("openmausbot-bench-")) throw new Error("--data must be a folder made for a bench (its path holds openmausbot-bench-)");
mkdirSync(join(values.data, "tmp"), { recursive: true });
const data = realpathSync(values.data);
const appRoot = resolve(values.app);
const entry = values.source ? join(appRoot, "server", "index.ts") : join(appRoot, "dist-server", "desktop-entry.mjs");
if (!existsSync(entry)) throw new Error(`${entry} is missing; run pnpm build:server in ${appRoot}`);
const electron = createRequire(import.meta.url)("electron");
const runtime = values.node ? process.execPath : electron;
const cache = join(dirname(data), `compile-cache-${values.label}`);
const port = Number(values.port);
const blocker = join(HERE, "testing", "bench-launch-block.cjs");

const agent = new Agent({ keepAlive: true });
const probe = () => new Promise((done) => {
  const req = request({ host: "127.0.0.1", port, path: "/api/health", agent }, (res) => { res.resume(); res.on("end", () => done(res.statusCode)); });
  req.on("error", () => done(0));
  req.end();
});

function once() {
  return new Promise((done) => {
    const args = [
      "--require", blocker,
      ...(values.source ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : []),
      ...(values["cpu-prof"] ? ["--cpu-prof", "--cpu-prof-dir", values["cpu-prof"]] : []),
      entry,
    ];
    const env = {
      PATH: dirname(process.execPath), HOME: data, TMPDIR: join(data, "tmp"), LANG: "en_US.UTF-8", OMB_DATA_DIR: data, OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1), OMB_TEST_SEALED_PATH: "1", OMB_DISABLE_ANNOUNCEMENTS: "1", OMB_STATIC_DIR: join(appRoot, "dist"),
      OMB_BENCH_EGRESS_LOG: join(dirname(data), "egress-server-start.log"),
      ...(values.node ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      ...(values["no-cache"] || values.source ? {} : { OMB_SERVER_COMPILE_CACHE: cache }),
    };
    const at = performance.now();
    const child = spawn(runtime, args, { env, cwd: join(data, "tmp"), stdio: ["ignore", "pipe", "pipe"] });
    let spawned, listening, output = "";
    child.once("spawn", () => { spawned = performance.now() - at; });
    const stop = (result) => { child.once("exit", () => done(result)); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); };
    const timer = setTimeout(() => stop({ failed: true, output: output.slice(-2000) }), 60_000);
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdout.on("data", async (chunk) => {
      output += chunk;
      if (listening !== undefined || !String(chunk).includes("openmausbot server on ")) return;
      listening = performance.now() - at;
      const status = await probe();
      const answered = performance.now() - at;
      clearTimeout(timer);
      stop({ spawned, listening, answered, status });
    });
    child.once("exit", (code) => { if (listening === undefined) { clearTimeout(timer); done({ failed: true, code, output: output.slice(-2000) }); } });
  });
}

const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null; };
if (values["no-cache"]) rmSync(cache, { recursive: true, force: true });
else if (!values.source) await once();
const runs = [];
for (let index = 0; index < Number(values.runs); index += 1) {
  const run = await once();
  if (run.failed) { console.error(JSON.stringify(run)); process.exit(1); }
  runs.push({ ...run, load: Math.round(loadavg()[0] * 10) / 10 });
  await new Promise((r) => setTimeout(r, 150));
}
agent.destroy();
process.stdout.write(`${JSON.stringify({
  label: values.label, entry: values.source ? "source" : "bundle", runtime: values.node ? `node ${process.version}` : "electron's node", cache: !values["no-cache"] && !values.source,
  runs: runs.length, medianMs: { spawned: median(runs.map((r) => r.spawned)), listening: median(runs.map((r) => r.listening)), answered: median(runs.map((r) => r.answered)) },
  minMs: { listening: Math.round(Math.min(...runs.map((r) => r.listening))) }, maxMs: { listening: Math.round(Math.max(...runs.map((r) => r.listening))) },
  status: runs.at(-1)?.status, load: loadavg().map((v) => Math.round(v * 10) / 10), listening: runs.map((r) => Math.round(r.listening)),
})}\n`);
