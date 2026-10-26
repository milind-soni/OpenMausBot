// Runs INSIDE a bot box (self-check.ts starts it) and tries what a hostile bot would: the server's database and settings,
// another bot's folders, another turn's process and environment, the server's own loopback routes, the local network,
// the cloud metadata service and the engines every turn runs; and what a legitimate turn needs: its own folders, an
// engine OpenMausBot installed, the harness routes and the public internet. Prints one JSON line of results. Every
// check is named here once, so the report's `checks: n/n` means these.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";

export const PROBE_SPEC_ENV = "OMB_BOX_PROBE";

export interface ProbeSpec {
  dataDir: string;
  cwd: string;
  botFolder: string;
  messagesDb: string;
  configJson: string;
  /** Names that must not appear in the box's view of the data folder. */
  serverFiles: string[];
  otherWorkspace: string;
  otherTaskWorkspace: string;
  /** An engine installed like OpenMausBot installs one: `name` on PATH, linked from `bin`, printing `says`. */
  engine: { bin: string; name: string; says: string };
  marker: string;
  canaryPid: number;
  serverPid: number;
  hostTmpFile: string;
  harnessPort: number;
  egressPort: number;
  /** A loopback port on the host that answers (the fixture's server): unreachable from the box except through the gates. */
  privatePort: number;
  /** `host:port` on the public internet, or null to skip the "public allowed" check. */
  publicTarget: string | null;
  /** Checks that apply only when the box has its own network. */
  isolatedNet: boolean;
  /** T0c: the seccomp filter is on, so a kernel-keyring call must fail with EPERM (an unprivileged process may make it otherwise). */
  seccomp?: boolean;
  /** T0b: a model call through the broker, and the real key's value that must be nowhere in the box. */
  broker?: { port: number; token: string; provider: string; path: string; keyNames: string[]; marker: string };
}

export interface ProbeResult { id: string; ok: boolean; detail: string }

const fails = (fn: () => unknown): { failed: boolean; code: string } => {
  try { fn(); return { failed: false, code: "ok" }; } catch (error) { return { failed: true, code: (error as NodeJS.ErrnoException).code ?? "error" }; }
};

function connectStatus(port: number, host: string, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve("timeout"); });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
  });
}

function httpStatus(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 5_000 }, (res) => { res.resume(); resolve(String(res.statusCode)); });
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.on("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
    req.end();
  });
}

/** `CONNECT host:port` through the egress bridge: the status line's code. */
function connectThroughGate(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    socket.setTimeout(10_000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) { socket.destroy(); resolve(/^HTTP\/1\.[01] (\d{3})/.exec(buffer)?.[1] ?? "malformed"); }
    });
    socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
  });
}

function scanForMarker(root: string, marker: string, budget: { files: number }): number {
  let hits = 0;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return 0; }
  for (const name of entries) {
    if (budget.files-- <= 0) return hits;
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) hits += scanForMarker(path, marker, budget);
      else if (stat.isFile() && stat.size < 1_000_000 && readFileSync(path, "latin1").includes(marker)) hits += 1;
    } catch {}
  }
  return hits;
}

export async function runProbe(spec: ProbeSpec, env: Record<string, string | undefined> = process.env): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const add = (id: string, ok: boolean, detail: string) => results.push({ id, ok, detail });
  const hidden = (id: string, path: string) => { const r = fails(() => readFileSync(path)); add(id, r.failed, r.code); };

  hidden("messages-db-hidden", spec.messagesDb);
  hidden("config-hidden", spec.configJson);
  let listing: string[] = [];
  try { listing = readdirSync(spec.dataDir); } catch {}
  const leaked = listing.filter((name) => spec.serverFiles.includes(name));
  add("data-dir-empty", leaked.length === 0, leaked.length ? `sees ${leaked.join(",")}` : `sees ${listing.length} entries`);
  hidden("other-bot-folder-hidden", join(spec.otherWorkspace, "MEMORY.md"));
  hidden("other-task-folder-hidden", join(spec.otherTaskWorkspace, "notes.md"));
  add("fly-api-hidden", !existsSync("/.fly"), existsSync("/.fly") ? "/.fly visible" : "absent");
  // The spec itself names the marker; every other value must not.
  const inEnv = Object.entries(env).filter(([name, value]) => name !== PROBE_SPEC_ENV && value?.includes(spec.marker)).map(([name]) => name);
  add("secret-not-in-env", inEnv.length === 0, inEnv.length ? `in ${inEnv.join(",")}` : "absent");
  const onDisk = scanForMarker(spec.dataDir, spec.marker, { files: 5_000 }) + scanForMarker("/tmp", spec.marker, { files: 5_000 }) + scanForMarker(spec.cwd, spec.marker, { files: 5_000 });
  add("secret-not-on-disk", onDisk === 0, `${onDisk} hits`);
  add("other-pid-hidden", !existsSync(`/proc/${spec.canaryPid}`), existsSync(`/proc/${spec.canaryPid}`) ? "visible" : "absent");
  const environ = fails(() => readFileSync(`/proc/${spec.canaryPid}/environ`));
  add("other-env-unreadable", environ.failed, environ.code);
  add("server-pid-hidden", !existsSync(`/proc/${spec.serverPid}`), existsSync(`/proc/${spec.serverPid}`) ? "visible" : "absent");
  const own = fails(() => { writeFileSync(join(spec.cwd, ".box-probe"), "ok"); if (readFileSync(join(spec.cwd, ".box-probe"), "utf8") !== "ok") throw new Error("mismatch"); });
  add("own-cwd-rw", !own.failed, own.code);
  const folder = fails(() => writeFileSync(join(spec.botFolder, ".box-probe"), "ok"));
  add("bot-folder-rw", !folder.failed, folder.code);
  const engine = spawnSync(spec.engine.name, [], { encoding: "utf8", timeout: 10_000, env: env as NodeJS.ProcessEnv });
  add("engine-runs", engine.stdout?.trim() === spec.engine.says, engine.error ? (engine.error as NodeJS.ErrnoException).code ?? "error" : `exit ${engine.status}`);
  const tamper = fails(() => writeFileSync(join(spec.engine.bin, ".box-probe"), "#!/bin/sh\n"));
  add("engine-read-only", existsSync(join(spec.engine.bin, spec.engine.name)) && tamper.failed, tamper.code);
  add("tmp-private", !existsSync(spec.hostTmpFile), existsSync(spec.hostTmpFile) ? "host /tmp visible" : "private");
  add("hostname-private", hostname() === "omb-box", hostname() === "omb-box" ? "omb-box" : "host name visible");

  add("harness-internal-allowed", (await httpStatus(spec.harnessPort, "/api/internal/box-probe")) === "200", "GET /api/internal/box-probe");
  add("harness-other-refused", (await httpStatus(spec.harnessPort, "/api/bots")) === "403", "GET /api/bots");
  if (spec.isolatedNet) {
    const direct = await connectStatus(spec.privatePort, "127.0.0.1");
    add("host-loopback-unreachable", direct !== "connected", direct);
    const outside = await connectStatus(443, "1.1.1.1", 3_000);
    add("no-direct-internet", outside !== "connected", outside);
  }
  add("egress-loopback-refused", (await connectThroughGate(spec.egressPort, `127.0.0.1:${spec.privatePort}`)) === "403", "CONNECT loopback");
  add("egress-metadata-refused", (await connectThroughGate(spec.egressPort, "169.254.169.254:80")) === "403", "CONNECT metadata");
  add("egress-private-refused", (await connectThroughGate(spec.egressPort, "10.0.0.1:443")) === "403", "CONNECT private");
  if (spec.publicTarget) add("egress-public-allowed", (await connectThroughGate(spec.egressPort, spec.publicTarget)) === "200", `CONNECT ${spec.publicTarget}`);
  if (spec.seccomp) {
    // add_key(2) into the process keyring: fine for any user, EPERM under the box's filter. python3 is in the image.
    const probe = "import ctypes,os;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(248,b'user',b'omb-box-probe',b'v',1,-2);print('ok' if r>=0 else os.strerror(ctypes.get_errno()))";
    const result = spawnSync("python3", ["-c", probe], { encoding: "utf8", timeout: 10_000 });
    const text = (result.stdout || result.stderr || "").trim();
    add("keyring-denied", /Operation not permitted/.test(text), text.slice(0, 60) || `exit ${result.status}`);
  }
  if (spec.broker) {
    const { port, token, provider, path, keyNames, marker: key } = spec.broker;
    const keys = keyNames.filter((name) => !env[name] || !env[name]!.startsWith("omb_t0_"));
    const anywhere = Object.entries(env).filter(([name, value]) => name !== PROBE_SPEC_ENV && value?.includes(key)).map(([name]) => name);
    add("no-provider-key-in-env", keys.length === 0 && anywhere.length === 0, anywhere.length ? `raw key in ${anywhere.join(",")}` : keys.length ? `no token in ${keys.join(",")}` : "tokens only");
    const base = env.ANTHROPIC_BASE_URL ?? "";
    add("base-url-is-broker", base === `http://127.0.0.1:${port}/b/${token}/${provider}`, base ? "points at the broker" : "unset");
    add("broker-call-works", (await httpStatus(port, `/b/${token}/${provider}${path}`)) === "200", `GET /b/<token>/${provider}${path}`);
    add("broker-wrong-token-refused", (await httpStatus(port, `/b/omb_t0_${"0".repeat(48)}/${provider}${path}`)) === "401", "wrong token");
    add("broker-other-grant-refused", (await httpStatus(port, `/b/${token}/openai${path}`)) === "403", "a grant the token lacks");
    add("broker-key-not-on-disk", scanForMarker(spec.dataDir, key, { files: 5_000 }) + scanForMarker("/tmp", key, { files: 5_000 }) === 0, "0 hits");
  }
  return results;
}

if (process.argv[1] && /box-probe\.[jt]s$/.test(process.argv[1])) {
  const raw = process.env[PROBE_SPEC_ENV];
  if (!raw) { console.error(`${PROBE_SPEC_ENV} is not set`); process.exit(2); }
  runProbe(JSON.parse(raw) as ProbeSpec).then((results) => { process.stdout.write(`${JSON.stringify({ results })}\n`); }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
