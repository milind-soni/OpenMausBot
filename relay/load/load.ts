// Load test: one relay process, then many host control sockets, a set of spliced sessions, and paced binary traffic
// both ways. Reports the relay's CPU and memory (from its own /metrics) and the forward latency of every message.
//
//   node load/load.ts --hosts 10000 --sessions 1000 --mbps 200 --seconds 60 [--workers 4] [--size 16384]
//
// Generators run in worker threads of this process; on one machine they compete with the relay for CPU, so the
// relay's numbers here are an upper bound on its cost.
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, createPrivateKey } from "node:crypto";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { WebSocket } from "ws";
import { sha256, SUBPROTOCOL } from "../src/wire.ts";

interface Options {
  hosts: number;
  sessions: number;
  mbps: number;
  seconds: number;
  workers: number;
  size: number;
}

interface WorkerInput {
  url: string;
  keyDer: Buffer;
  hosts: number;
  sessions: number;
  bytesPerSecondEachWay: number;
  size: number;
  seconds: number;
  index: number;
}

interface WorkerReport {
  hostsUp: number;
  sessionsUp: number;
  sent: number;
  received: number;
  latenciesMs: number[];
  errors: Record<string, number>;
}

function options(argv: string[]): Options {
  const value = (name: string, fallback: number) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
  };
  return {
    hosts: value("hosts", 2_000),
    sessions: value("sessions", 200),
    mbps: value("mbps", 50),
    seconds: value("seconds", 30),
    workers: value("workers", Math.max(1, Math.min(4, availableParallelism() - 2))),
    size: value("size", 16_384),
  };
}

const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));

function token(keyDer: Buffer, hid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ v: 1, kid: "k1", hid, iid: "load", iat: now, exp: now + 3600 })).toString("base64url");
  const key = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  return `${body}.${sign(null, Buffer.from(body, "ascii"), key).toString("base64url")}`;
}

function open(url: string, path: string, ip: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${path}`, [SUBPROTOCOL], { headers: { "x-forwarded-for": ip }, perMessageDeflate: false });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.once("close", (code) => reject(new Error(`closed ${code}`)));
  });
}

async function inBatches<T>(count: number, batch: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < count; start += batch) {
    out.push(...(await Promise.all(Array.from({ length: Math.min(batch, count - start) }, (_, k) => make(start + k)))));
  }
  return out;
}

async function runWorker(input: WorkerInput): Promise<WorkerReport> {
  const report: WorkerReport = { hostsUp: 0, sessionsUp: 0, sent: 0, received: 0, latenciesMs: [], errors: {} };
  const fail = (what: string) => (report.errors[what] = (report.errors[what] ?? 0) + 1);
  const ip = (n: number) => `10.${input.index}.${(n >> 8) & 255}.${n & 255}`;
  const hosts = await inBatches(input.hosts, 100, async (i) => {
    const hid = randomBytes(16).toString("base64url");
    const adm = randomBytes(32);
    const hostToken = token(input.keyDer, hid);
    try {
      const control = await open(input.url, "/v1/host", ip(i));
      control.send(JSON.stringify({ t: "auth", v: 1, token: hostToken }));
      await nextMessage(control);
      control.send(JSON.stringify({ t: "admit", set: [sha256(adm).toString("base64url")] }));
      control.on("close", (code) => fail(`control closed ${code}`));
      report.hostsUp += 1;
      return { control, hid, adm, hostToken };
    } catch (error) {
      fail(`host: ${(error as Error).message}`);
      return undefined;
    }
  });
  const live = hosts.filter((host) => host !== undefined);
  const pairs = await inBatches(Math.min(input.sessions, live.length), 50, async (i) => {
    const host = live[i]!;
    try {
      const phone = await open(input.url, "/v1/phone", ip(60_000 + i));
      const opened = nextMessage(host.control);
      phone.send(JSON.stringify({ t: "phone", v: 1, hid: host.hid, adm: host.adm.toString("base64url") }));
      const { sid } = await opened;
      const ready = nextMessage(phone);
      const data = await open(input.url, "/v1/host/data", ip(i));
      data.send(JSON.stringify({ t: "data", v: 1, sid, token: host.hostToken }));
      await ready;
      report.sessionsUp += 1;
      return { phone, data };
    } catch (error) {
      fail(`session: ${(error as Error).message}`);
      return undefined;
    }
  });
  const sessions = pairs.filter((pair) => pair !== undefined);
  parentPort!.postMessage({ ramped: true });
  await new Promise<void>((resolve) => parentPort!.once("message", () => resolve()));

  const payload = randomBytes(input.size);
  const onMessage = (data: Buffer) => {
    report.received += data.length;
    report.latenciesMs.push(performance.now() - data.readDoubleLE(0));
  };
  for (const { phone, data } of sessions) {
    phone.on("message", onMessage);
    data.on("message", onMessage);
  }
  const tickMs = 20;
  const perTick = (input.bytesPerSecondEachWay * tickMs) / 1000 / Math.max(1, sessions.length);
  const owed = sessions.map(() => Math.random() * input.size);
  const stopAt = performance.now() + input.seconds * 1000;
  const progress = setInterval(() => {
    const open = sessions.filter(({ phone, data }) => phone.readyState === WebSocket.OPEN && data.readyState === WebSocket.OPEN).length;
    process.stderr.write(`worker ${input.index}: sent ${(report.sent / 1e6).toFixed(1)} MB, received ${(report.received / 1e6).toFixed(1)} MB, ${open}/${sessions.length} sessions open\n`);
  }, 5_000);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (performance.now() >= stopAt) {
        clearInterval(timer);
        resolve();
        return;
      }
      sessions.forEach(({ phone, data }, i) => {
        owed[i]! += perTick;
        const messages = Math.floor(owed[i]! / input.size);
        owed[i]! -= messages * input.size;
        for (let m = 0; m < messages; m++) {
          for (const ws of [phone, data]) {
            if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 4 * 1024 * 1024) continue;
            const message = Buffer.from(payload);
            message.writeDoubleLE(performance.now(), 0);
            ws.send(message);
            report.sent += message.length;
          }
        }
      });
    }, tickMs);
  });
  clearInterval(progress);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return report;
}

async function scrape(url: string, bearer: string): Promise<Record<string, number>> {
  const text = await (await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${bearer}` } })).text();
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^([a-z0-9_]+(?:\{[^}]*\})?) ([0-9.e+-]+)$/.exec(line);
    if (match) out[match[1]!] = Number(match[2]);
  }
  return out;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;

async function main(): Promise<void> {
  const opts = options(process.argv);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyDer = privateKey.export({ format: "der", type: "pkcs8" });
  const bearer = randomBytes(24).toString("base64url");
  const relay = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    cwd: RELAY_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      RELAY_NODE: "relay1",
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "0",
      RELAY_TOKEN_KEYS: JSON.stringify({ k1: publicKey.export({ format: "jwk" }).x }),
      RELAY_METRICS_TOKEN: bearer,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    relay.stdout!.on("data", (chunk) => {
      out += chunk;
      const start = /"ev":"start","port":(\d+)/.exec(out);
      if (start) resolve(Number(start[1]));
    });
    relay.once("exit", () => reject(new Error("the relay exited")));
  });
  relay.stdout!.resume();
  const url = `ws://127.0.0.1:${port}`;
  const http = `http://127.0.0.1:${port}`;
  console.log(`relay pid ${relay.pid} on ${port}; ${JSON.stringify(opts)}`);

  const rampStart = performance.now();
  const workers = Array.from({ length: opts.workers }, (_, index) => {
    const share = (total: number) => Math.floor(total / opts.workers) + (index < total % opts.workers ? 1 : 0);
    const input: WorkerInput = {
      url,
      keyDer,
      hosts: share(opts.hosts),
      sessions: share(opts.sessions),
      bytesPerSecondEachWay: (opts.mbps * 1e6) / 8 / 2 / opts.workers,
      size: opts.size,
      seconds: opts.seconds,
      index,
    };
    return new Worker(fileURLToPath(import.meta.url), { workerData: input, execArgv: ["--disable-warning=ExperimentalWarning"] });
  });
  await Promise.all(workers.map((worker) => new Promise((resolve) => worker.once("message", resolve))));
  const rampSeconds = (performance.now() - rampStart) / 1000;
  const idle = await scrape(http, bearer);
  console.log(`ramped in ${rampSeconds.toFixed(1)} s: ${idle.relay_hosts_connected} hosts, ${idle.relay_sessions_spliced} sessions, RSS ${(idle.process_resident_memory_bytes! / 1e6).toFixed(0)} MB`);

  const reports = workers.map((worker) => new Promise<WorkerReport>((resolve) => worker.once("message", resolve)));
  const before = await scrape(http, bearer);
  const started = performance.now();
  for (const worker of workers) worker.postMessage("go");
  let peakRss = before.process_resident_memory_bytes ?? 0;
  let peakLag = 0;
  const sampler = setInterval(async () => {
    const m = await scrape(http, bearer).catch(() => undefined);
    if (!m) return;
    peakRss = Math.max(peakRss, m.process_resident_memory_bytes ?? 0);
    peakLag = Math.max(peakLag, m.relay_event_loop_lag_p99_seconds ?? 0);
  }, 2_000);
  const done = await Promise.all(reports);
  clearInterval(sampler);
  const wall = (performance.now() - started) / 1000;
  const afterRun = await scrape(http, bearer);
  for (const worker of workers) void worker.terminate();
  relay.kill("SIGTERM");

  const latencies = done.flatMap((report) => report.latenciesMs).sort((a, b) => a - b);
  const forwarded = (afterRun['relay_bytes_total{dir="up"}'] ?? 0) + (afterRun['relay_bytes_total{dir="down"}'] ?? 0)
    - (before['relay_bytes_total{dir="up"}'] ?? 0) - (before['relay_bytes_total{dir="down"}'] ?? 0);
  const cpu = (afterRun.process_cpu_seconds_total! - before.process_cpu_seconds_total!) / wall;
  const errors: Record<string, number> = {};
  for (const report of done) for (const [what, count] of Object.entries(report.errors)) errors[what] = (errors[what] ?? 0) + count;
  const summary = {
    hosts: done.reduce((sum, r) => sum + r.hostsUp, 0),
    sessions: done.reduce((sum, r) => sum + r.sessionsUp, 0),
    seconds: Number(wall.toFixed(1)),
    relayedMbps: Number(((forwarded * 8) / wall / 1e6).toFixed(1)),
    relayCpuCores: Number(cpu.toFixed(3)),
    relayRssMbIdle: Math.round(idle.process_resident_memory_bytes! / 1e6),
    relayRssMbPeak: Math.round(peakRss / 1e6),
    eventLoopLagP99MsPeak: Number((peakLag * 1000).toFixed(1)),
    latencyMs: { p50: percentile(latencies, 50), p99: percentile(latencies, 99), max: latencies.at(-1) ?? NaN, samples: latencies.length },
    errors,
  };
  summary.latencyMs = Object.fromEntries(Object.entries(summary.latencyMs).map(([k, v]) => [k, Number(v.toFixed(2))])) as typeof summary.latencyMs;
  console.log(JSON.stringify(summary, null, 2));
  await new Promise((resolve) => relay.once("exit", resolve));
  process.exit(0);
}

if (isMainThread) {
  await main();
} else {
  const input = workerData as WorkerInput;
  const report = await runWorker({ ...input, keyDer: Buffer.from(input.keyDer) });
  parentPort!.postMessage(report);
}
