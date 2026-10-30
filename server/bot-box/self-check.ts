// Proves the box on this machine: a fixture laid out like a data folder (a canary database, settings, another bot's
// folders), a canary process holding a secret, a fixture "server" on loopback, fresh gates, and box-probe.ts run inside
// a real box granted only one bot's folders. The result is the report's `checks: n/n`; the same run with a mutation
// (plan.ts BoxMutation) must fail exactly the checks that protection guards.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { engineInstallRoots, npmEnginesPrefix } from "../engine-roots.ts";
import { BOX_PROBE_SCRIPT, BoxRunner, BOX_BROKER_PORT, BOX_EGRESS_PORT, defaultCodeRoots, type BoxChecks } from "./box.ts";
import { closeSync, existsSync } from "node:fs";
import type { BridgeTools } from "./bridge.ts";
import { openCredentialBroker } from "./broker.ts";
import { openBoxEgressGate } from "./egress-gate.ts";
import { openHarnessGate } from "./harness-gate.ts";
import type { BoxBridge, BoxMutation } from "./plan.ts";
import { PROBE_SPEC_ENV, type ProbeResult, type ProbeSpec } from "./box-probe.ts";

export interface SelfCheckOptions {
  bwrap: string;
  bridge: BridgeTools;
  /** Where the fixture lives (a private folder under the data folder, or a temp dir). */
  root: string;
  denyEnv: ReadonlySet<string>;
  codeRoots?: readonly string[];
  /** The probe script (box-probe.ts) to run inside the box; the bundled one by default. */
  probeScript?: string;
  mutate?: ReadonlySet<BoxMutation>;
  /** `host:port` on the public internet; null skips that check; undefined tries example.com:443 and skips when the host itself cannot reach it. */
  publicTarget?: string | null;
  timeoutMs?: number;
  /** T0b: false leaves the broker out; by default a fixture broker is opened and the probe gets a token for a grant to
   * the fixture server, with the key names it must find replaced by that token. */
  broker?: boolean;
  /** T0c: the seccomp filter file to hand the box; none (or an unsupported architecture) loads no filter. */
  seccompFile?: string | null;
}

export interface SelfCheckResult extends BoxChecks {
  results: ProbeResult[];
  skipped: string[];
  durationMs: number;
  /** Output of a probe that did not answer, for the log. */
  error?: string;
}

const MARKER_PREFIX = "OPENMAUSBOT-BOX-CANARY-";

/** The host's own path out through the gate socket: whether the public internet answers at all. */
function hostConnect(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setTimeout(8_000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => { buffer += chunk.toString("latin1"); if (buffer.includes("\r\n\r\n")) { socket.destroy(); resolve(/^HTTP\/1\.[01] (\d{3})/.exec(buffer)?.[1] ?? "malformed"); } });
    socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
  });
}

export async function runBoxSelfCheck(options: SelfCheckOptions): Promise<SelfCheckResult> {
  const startedAt = Date.now();
  const marker = `${MARKER_PREFIX}${randomBytes(12).toString("hex")}`;
  const root = join(options.root, `check-${randomBytes(4).toString("hex")}`);
  const home = join(root, "home"), data = join(home, ".openmausbot"), sockets = join(root, "s");
  const cwd = join(data, "task-workspaces", "probe", "t1"), botFolder = join(data, "workspaces", "probe");
  const otherWorkspace = join(data, "workspaces", "other"), otherTask = join(data, "task-workspaces", "other", "t2");
  for (const dir of [cwd, botFolder, otherWorkspace, otherTask, join(data, "providers"), join(data, "tools"), sockets]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const serverFiles = ["messages.db", "config.json", "logins.json", "providers"];
  writeFileSync(join(data, "messages.db"), `SQLite format 3\u0000 ${marker}`);
  writeFileSync(join(data, "config.json"), JSON.stringify({ anthropic: { key: `sk-ant-${marker}` } }));
  writeFileSync(join(data, "logins.json"), JSON.stringify([{ password: marker }]));
  writeFileSync(join(data, "providers", "key"), marker);
  writeFileSync(join(data, "tools", "token"), marker);
  writeFileSync(join(otherWorkspace, "MEMORY.md"), `other bot ${marker}`);
  writeFileSync(join(otherTask, "notes.md"), `other turn ${marker}`);
  writeFileSync(join(botFolder, "MEMORY.md"), "own bot");
  // An engine laid out as `npm install -g --prefix` leaves one: its bin entry a relative link into the package.
  const engineBin = join(npmEnginesPrefix(data), "bin"), engineName = "omb-probe-engine", engineSays = "omb-probe-engine ran";
  const enginePackage = join(npmEnginesPrefix(data), "lib", "node_modules", engineName, "bin");
  for (const dir of [engineBin, enginePackage]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(enginePackage, engineName), `#!/bin/sh\necho '${engineSays}'\n`, { mode: 0o755 });
  symlinkSync(join("..", "lib", "node_modules", engineName, "bin", engineName), join(engineBin, engineName));
  // The box's private /tmp is what is checked, so the host file goes to /tmp itself where there is one.
  const hostTmpFile = join(existsSync("/tmp") ? "/tmp" : tmpdir(), `omb-box-check-${randomBytes(6).toString("hex")}`);
  writeFileSync(hostTmpFile, "host tmp");

  // The key the broker takes over: its own value, so a box that is never brokered (the host's network) is not counted
  // as leaking the canary when the raw key stays.
  const brokerKey = `sk-ant-${randomBytes(12).toString("hex")}`;
  const canary = spawn("sleep", ["120"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OMB_BOX_CANARY: marker }, stdio: "ignore" });
  const answer = (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: { writeHead(code: number, headers: Record<string, string>): unknown; end(body: string): void }) => {
    // A model call must arrive with the real key, never the token (so the broker forwarded and swapped it).
    const model = req.url?.startsWith("/v1/");
    const status = !model ? 200 : req.headers["x-api-key"] === brokerKey ? 200 : 401;
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ path: req.url, status }));
  };
  // Two fixture listeners on the host's loopback: the "server" the harness gate forwards to, and a private one that is
  // bridged nowhere, so reaching it from the box would mean the box shares the host's network.
  const upstream = createServer(answer), privateServer = createServer(answer);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
  const serverPort = (upstream.address() as { port: number }).port, privatePort = (privateServer.address() as { port: number }).port;
  const egressSocket = join(sockets, "egress.sock"), harnessSocket = join(sockets, "harness.sock"), brokerSocket = join(sockets, "broker.sock");
  const egress = await openBoxEgressGate({ socketPath: egressSocket });
  const harness = await openHarnessGate({ socketPath: harnessSocket, port: serverPort });
  // The broker: the probe's environment holds a real-looking key, which the runner's rewrite turns into a token whose
  // grant reaches the fixture server; the probe checks the key is gone and the token works.
  const credentials = options.broker === false ? null : await openCredentialBroker({ socketPath: brokerSocket });
  const skipped: string[] = [];
  let publicTarget: string | null = options.publicTarget === undefined ? "example.com:443" : options.publicTarget;
  if (publicTarget && (await hostConnect(egressSocket, publicTarget)) !== "200") { skipped.push("egress-public-allowed"); publicTarget = null; }

  const bridges: BoxBridge[] = [
    { name: "egress", port: BOX_EGRESS_PORT, socket: egressSocket },
    { name: "harness", port: serverPort, socket: harnessSocket },
    ...(credentials ? [{ name: "broker", port: BOX_BROKER_PORT, socket: brokerSocket }] : []),
  ];
  const runner = new BoxRunner({
    bwrap: options.bwrap, bridge: options.bridge, denyEnv: options.denyEnv,
    setup: { dataDir: data, home, codeRoots: options.codeRoots ?? defaultCodeRoots(), engineRoots: engineInstallRoots(data), bridges, mutate: options.mutate },
    broker: credentials ? { port: BOX_BROKER_PORT, mintForProcess: credentials.mintForProcess, revoke: credentials.revoke } : null,
    seccompFile: options.seccompFile ?? null,
  });
  const isolatedNet = !options.mutate?.has("share-net");
  const spec: ProbeSpec = {
    dataDir: data, cwd, botFolder, messagesDb: join(data, "messages.db"), configJson: join(data, "config.json"), serverFiles,
    otherWorkspace, otherTaskWorkspace: otherTask, engine: { bin: engineBin, name: engineName, says: engineSays }, marker, canaryPid: canary.pid ?? 0, serverPid: process.pid, hostTmpFile,
    harnessPort: serverPort, egressPort: BOX_EGRESS_PORT, privatePort, publicTarget, isolatedNet,
    // Checked whenever a filter is in the setup: the no-seccomp mutation leaves it out of the box, so the check must fail.
    seccomp: Boolean(options.seccompFile),
  };
  const wrapped = runner.wrap({
    command: process.execPath, args: [options.probeScript ?? BOX_PROBE_SCRIPT], cwd, botId: "probe",
    env: {
      PATH: [engineBin, process.env.PATH].filter(Boolean).join(delimiter), HOME: home, LANG: process.env.LANG, TMPDIR: "/tmp",
      // What must not get in: a control-plane secret, a workspace credential and an unlisted name, each holding the marker.
      OMB_CLOUD_BOOTSTRAP_SECRET: marker, COMPOSIO_API_KEY: marker, SOME_OTHER_SECRET: marker,
      // The real-looking key the broker takes over; its upstream is the fixture server, which answers 200 only to the real key.
      ...(credentials ? { ANTHROPIC_API_KEY: brokerKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${serverPort}/v1` } : {}),
    },
  });
  if (credentials && wrapped.token) spec.broker = { port: BOX_BROKER_PORT, token: wrapped.token, provider: "anthropic", path: "/messages", keyNames: ["ANTHROPIC_API_KEY"], marker: brokerKey };
  wrapped.env[PROBE_SPEC_ENV] = JSON.stringify(spec);
  let stdout = "", stderr = "";
  const results = await new Promise<ProbeResult[] | string>((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
    for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(`the probe did not answer within ${options.timeoutMs ?? 60_000} ms`); }, options.timeoutMs ?? 60_000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); resolve(`the box could not start: ${error.message}`); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try { resolve((JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { results: ProbeResult[] }).results); } catch { resolve(`the probe exited with ${code}: ${stderr.slice(-400)}`); }
    });
  });
  canary.kill("SIGKILL");
  wrapped.release();
  await Promise.all([egress.close(), harness.close(), credentials?.close(), new Promise<void>((resolve) => upstream.close(() => resolve())), new Promise<void>((resolve) => privateServer.close(() => resolve()))]);
  rmSync(root, { recursive: true, force: true });
  rmSync(hostTmpFile, { force: true });
  const durationMs = Date.now() - startedAt;
  if (typeof results === "string") return { passed: 0, total: 0, failed: [], results: [], skipped, durationMs, at: Date.now(), error: results };
  const failed = results.filter((result) => !result.ok).map((result) => result.id);
  return { passed: results.length - failed.length, total: results.length, failed, results, skipped, durationMs, at: Date.now() };
}
