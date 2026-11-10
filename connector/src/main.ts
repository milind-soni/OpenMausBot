// mausbot-connector: `run` (the service), `enroll` (the code on stdin), `status`, `probe`, `job` (one job from root on this
// server), `audit` (the audit log, checked), `pause` and `resume` (remote management, by the server's admin), `version`.
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";

import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import { AdoptedHome, enrolmentRefusal } from "./adopted-home.ts";
import { Agent, savedConfig, transferAuthorization } from "./agent.ts";
import { AuditLog, verifyAudit } from "./audit.ts";
import { serveCustomerRunRequest } from "./customer-run-requests.ts";
import { reducedHeartbeat, reducedReply } from "./customer-run.ts";
import { SocketDocker, dockerApiProblem, type DockerInfo } from "./docker.ts";
import { adminOrigin, enroll } from "./enroll.ts";
import { readHealth } from "./home-health.ts";
import { neverOlder } from "./images.ts";
import { serveRequest } from "./home-requests.ts";
import { Home } from "./home.ts";
import { hostChecks, hostFacts, hostHealth, probeBox, type BoxProbeResult, type HostReader } from "./host.ts";
import { jobDesk, jobRunner, resultEvent } from "./jobs.ts";
import { sendLocalJob, serveLocalJobs } from "./local.ts";
import { POLICY_FILE } from "./policy.ts";
import { errorText, log, registerSecret } from "./log.ts";
import { PROTOCOL_VERSION, type CheckId, type ConnectorIdentity, type Heartbeat, type HostHealth, type ServerMode } from "./protocol.ts";
import { SELF_UPDATE_DEADLINE_MS, SelfUpdater, ownContainer } from "./self-update.ts";
import { AUDIT_FILE, CONNECTOR_VERSION, HOME_PORT, PATHS, SECCOMP_FILE, envSeconds } from "./settings.ts";
import { StateStore, type AgentRecord } from "./state.ts";
import { httpTransfer } from "./transfer.ts";

const read = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

const reader: HostReader = {
  proc: read,
  installedSeccomp: () => read(join(PATHS.hostConfig, SECCOMP_FILE)),
  shippedSeccomp: () => read(join(PATHS.profiles, SECCOMP_FILE)),
  disk: () => {
    try {
      const stats = statfsSync(PATHS.state);
      return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
    } catch {
      return { free: 0, total: 0 };
    }
  },
};

const auditLog = () => new AuditLog(join(PATHS.audit, AUDIT_FILE));
const identity = (): ConnectorIdentity => ({ version: CONNECTOR_VERSION, protocol: PROTOCOL_VERSION, image: process.env.MAUSBOT_CONNECTOR_IMAGE || null });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stricter of what the server was enrolled as and what install.sh started this container as. */
function serverMode(record: AgentRecord | null): ServerMode {
  return record?.mode === "customer-run" || process.env.MAUSBOT_MODE === "customer-run" ? "customer-run" : "operated";
}

/** The bot box's profiles belong to a home the connector makes; a home its owner installed is not given them. */
const OPERATED_ONLY_CHECKS: ReadonlySet<CheckId> = new Set(["apparmor", "profiles", "box"]);

function seccomp(): string {
  const text = reader.installedSeccomp();
  if (!text) throw new Error(`The bot box's seccomp profile is missing from ${PATHS.hostConfig}. Run the install command again to repair it.`);
  return text;
}

/** What the host reports, with Docker's info read again at most every five minutes and the box probed every six hours. */
function hostReporter(docker: SocketDocker, admin: () => string | null, mode: ServerMode) {
  let info: { at: number; value: DockerInfo } | null = null;
  let box: { at: number; value: BoxProbeResult | null } | null = null;
  let clock: { at: number; skew: number | null } | null = null;
  const dockerInfo = async (fresh: boolean) => {
    if (fresh || !info || Date.now() - info.at > 5 * 60_000) info = { at: Date.now(), value: await docker.info() };
    return info.value;
  };
  const probe = async (fresh: boolean) => {
    const image = process.env.MAUSBOT_CONNECTOR_IMAGE;
    if (!image || mode === "customer-run") return null;
    if (fresh || !box || Date.now() - box.at > 6 * 60 * 60_000) {
      let value: BoxProbeResult | null;
      try { value = await probeBox(docker, image, seccomp()); } catch (error) { value = { ok: false, fix: errorText(error) }; }
      box = { at: Date.now(), value };
    }
    return box.value;
  };
  const skew = async (fresh: boolean) => {
    const origin = admin();
    if (!origin) return null;
    if (fresh || !clock || Date.now() - clock.at > 60 * 60_000) {
      let value: number | null = null;
      try {
        const sent = Date.now();
        const response = await fetch(origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
        const date = Date.parse(response.headers.get("date") ?? "");
        if (Number.isFinite(date)) value = Math.round(((sent + Date.now()) / 2 - date) / 1000);
      } catch {
        value = null;
      }
      clock = { at: Date.now(), skew: value };
    }
    return clock.skew;
  };
  return {
    info: dockerInfo,
    async health(fresh: boolean): Promise<HostHealth> {
      const [value, boxed, skewed] = await Promise.all([dockerInfo(fresh), probe(fresh), skew(fresh)]);
      const health = hostHealth(value, reader, { clockSkewS: skewed, box: boxed });
      return mode === "customer-run" ? { ...health, checks: health.checks.filter((check) => !OPERATED_ONLY_CHECKS.has(check.id)) } : health;
    },
  };
}

async function run(): Promise<void> {
  const state = new StateStore(PATHS.state);
  const docker = new SocketDocker(PATHS.docker);
  const instance = process.env.MAUSBOT_INSTANCE || "unknown";
  log(`MausBot connector ${CONNECTOR_VERSION} starting`);
  const audit = auditLog();
  const note = (event: Parameters<AuditLog["append"]>[0]) => {
    try { audit.append(event); } catch (error) { log(`could not write the audit log ${audit.file}: ${errorText(error)}`); }
  };
  note({ event: "connector", what: "started", version: CONNECTOR_VERSION, image: identity().image });
  // A connector removed with SIGKILL never said it went offline.
  state.saveStatus({ connected: false });
  for (let problem = await dockerApiProblem(docker, PATHS.docker); problem; problem = await dockerApiProblem(docker, PATHS.docker)) {
    log(problem);
    state.saveStatus({ lastError: problem });
    await sleep(10 * 60_000);
  }
  let record: AgentRecord | null = state.agent();
  if (!record) log("waiting for this server to be connected: run the install command with the code MausBot shows");
  const enrolledNow = !record;
  while (!record) {
    await sleep(2_000);
    record = state.agent();
  }
  registerSecret(record.privateKey);
  let current: AgentRecord = record;
  const mode = serverMode(record);
  if (enrolledNow) note({ event: "connector", what: "enrolled", version: CONNECTOR_VERSION, image: identity().image, boxId: record.boxId, mode });
  if (mode === "customer-run") log("this server is run by its owner: MausBot may only do what connector/src/customer-run.ts lists");
  const kept = savedConfig(state.adminConfig(), current);
  if (kept) log(`going by MausBot's schedule and policy kept on this server (version ${kept.version}) until MausBot answers`);
  const host = hostReporter(docker, () => current.admin, mode);
  const adopted = mode === "customer-run" ? new AdoptedHome({
    docker, state, log, diskFree: () => reader.disk().free, updateDir: PATHS.update,
    onStep: ({ id, type, step, detail }) => note({ event: "step", id, type, step, ...(detail ? { detail } : {}) }),
  }) : null;
  const home = adopted ?? new Home({
    docker, state, log, readHealth, seccomp, transfer: httpTransfer,
    diskFree: () => reader.disk().free,
    updateWindowMs: envSeconds("MAUSBOT_UPDATE_WAIT_S", 600, 60, 3600) * 1000,
    onStep: ({ id, type, step, detail }) => note({ event: "step", id, type, step, ...(detail ? { detail } : {}) }),
  });
  // On a customer-run server only its owner replaces the connector, and never with an older one: one from before this
  // mode would not know the mode.
  const updater = new SelfUpdater({ docker, state, log, instance, identity, ...(mode === "customer-run" ? { checkImage: neverOlder(docker) } : {}) });
  const heartbeat = async (): Promise<Heartbeat> => {
    await home.refreshHealth().catch(() => null);
    const facts = { host: await host.health(false), home: await home.report(), connector: identity() };
    return adopted ? reducedHeartbeat({ ...facts, paused: state.paused(), seats: adopted.seats }) : { heartbeat: facts };
  };
  let agent: Agent;
  const runner = jobRunner({
    ...(adopted ? { adopted } : { home: home as Home }),
    hostHealth: () => host.health(true),
    identity,
    admin: () => ({ origin: current.admin, authorization: (jobId) => transferAuthorization(current, jobId) }),
    selfUpdate: (job) => home.exclusive(() => updater.run(job, { pause: () => agent.stop(), resume: () => agent.start() })),
  });
  const desk = jobDesk({ run: runner, audit, log, policyFile: join(PATHS.hostConfig, POLICY_FILE), mode, paused: () => mode === "customer-run" && state.paused() });
  const connectHome = () => new Promise<Duplex>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: HOME_PORT });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  const makeAgent = () => new Agent({
    identity: () => current, log, heartbeat, handle: (job) => desk.submit(job, "admin"), status: (patch) => state.saveStatus(patch),
    nextCount: () => state.nextCount(),
    saveAdminKeys: (keys) => {
      current = { ...current, adminKeys: keys };
      state.saveAgent(current);
      log(`MausBot's signing keys are now ${Object.keys(keys).join(", ")}`);
    },
    config: { saved: () => state.adminConfig(), save: (config) => state.saveAdminConfig(config) },
    onConfig: (config) => log(`MausBot's schedule and policy (version ${config.version}) are kept on this server`),
    stream: (stream, accept) => (adopted
      ? serveCustomerRunRequest(stream, accept, {
        paused: () => state.paused(), record: note,
        facts: async () => {
          await adopted.refreshHealth().catch(() => null);
          return { home: await adopted.report(), connector: identity(), seats: adopted.seats, previousImage: adopted.previousImage };
        },
      })
      : serveRequest(stream, accept, { connectHome, record: note })),
    mode,
    ...(adopted ? { outgoing: reducedReply } : {}),
    refused: (refusal) => note({ event: "refused", by: "admin", code: refusal.code, why: refusal.message, ...(refusal.id ? { id: refusal.id } : {}), ...(refusal.type ? { type: refusal.type } : {}) }),
  });
  agent = makeAgent();

  const role = await updater.atStart(() => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SELF_UPDATE_DEADLINE_MS);
    agent.onConnected = () => {
      clearTimeout(timer);
      agent.onConnected = null;
      resolve(true);
    };
    agent.start();
  }));
  if (role.role === "superseded") {
    log("a newer connector runs this server now; this one stops");
    agent.stop();
    const self = await ownContainer(docker, instance).catch(() => null);
    if (self) await docker.stopContainer(self.Id, 10).catch(() => {});
    return;
  }
  const interrupted = state.home().operation?.type ?? "update";
  const recovered = await home.recover().catch((error) => {
    log(`could not finish the interrupted job: ${errorText(error)}`);
    return null;
  });
  if (recovered) {
    note(resultEvent("admin", interrupted, recovered));
    agent.reply(recovered);
  }
  if (role.role === "candidate") {
    note(resultEvent("admin", "self-update", role.reply));
    agent.reply(role.reply);
  }
  agent.start();
  await serveLocalJobs(PATHS.jobs, desk, log, mode).catch((error) => log(`jobs from this server are off: ${errorText(error)}`));

  setInterval(() => {
    home.supervise().catch((error) => log(`supervising the home failed: ${errorText(error)}`));
    const latest = state.agent();
    if (latest && serverMode(latest) !== mode) {
      log("this server was connected again in another mode; the connector restarts to take it up");
      agent.stop();
      process.exit(0);
    }
    if (latest && latest.publicKey !== current.publicKey) {
      log("this server was connected again with a new code; reconnecting");
      registerSecret(latest.privateKey);
      current = latest;
      note({ event: "connector", what: "enrolled", version: CONNECTOR_VERSION, image: identity().image, boxId: latest.boxId });
      agent.stop();
      agent = makeAgent();
      agent.start();
    }
  }, 10_000);
  const quit = () => {
    agent.stop();
    process.exit(0);
  };
  process.once("SIGTERM", quit);
  process.once("SIGINT", quit);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function enrollCommand(): Promise<void> {
  const admin = adminOrigin(process.env.MAUSBOT_ADMIN_URL);
  const code = (await readStdin()).trim();
  const state = new StateStore(PATHS.state);
  const docker = new SocketDocker(PATHS.docker);
  const mode = serverMode(null);
  const refusal = await enrolmentRefusal(mode, docker);
  if (refusal) throw new Error(refusal);
  const record = await enroll({ admin, code, host: hostFacts(await docker.info(), reader), connector: identity(), mode });
  state.saveAgent(record);
  // Connected again only once the service has connected with this token.
  state.saveStatus({ connected: false, unauthorized: false, lastError: null });
  console.log(`This server is connected to MausBot (server ${record.boxId}).`);
}

function statusCommand(): void {
  const state = new StateStore(PATHS.state);
  const record = state.agent();
  const status = state.status();
  const home = state.home();
  console.log(JSON.stringify({
    enrolled: Boolean(record), mode: serverMode(record), paused: state.paused(), admin: record?.admin ?? null, boxId: record?.boxId ?? null, teamId: record?.teamId ?? null,
    connected: status.connected, accepted: status.boxState === "accepted", unauthorized: status.unauthorized,
    lastConnectedAt: status.lastConnectedAt, lastHeartbeatAt: status.lastHeartbeatAt, config: state.adminConfig()?.version ?? null,
    lastError: status.lastError, home: { desired: home.desired, image: home.image, operation: home.operation?.type ?? null },
  }));
}

/**
 * One line per check for install.sh: `ok <id>`, `warn <id> <fix>` or `fail <id> <fix>`. With --json, one object
 * `{ok, checks}` for `openmausbot doctor --host`, which asks the connector on a server that runs one. Exits 1 when any
 * check fails.
 */
async function probeCommand(): Promise<void> {
  const docker = new SocketDocker(PATHS.docker);
  const unusable = await dockerApiProblem(docker, PATHS.docker);
  if (unusable) {
    console.log(process.argv.includes("--json") ? JSON.stringify({ ok: false, checks: [{ id: "docker", ok: false, fix: unusable }] }) : `fail docker ${unusable}`);
    process.exitCode = 1;
    return;
  }
  const image = process.env.MAUSBOT_CONNECTOR_IMAGE;
  let box: BoxProbeResult | null = null;
  try { box = image ? await probeBox(docker, image, seccomp()) : null; } catch (error) { box = { ok: false, fix: errorText(error) }; }
  const checks = hostChecks(await docker.info(), reader, { clockSkewS: null, box });
  const ok = checks.every((check) => check.ok);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ok, checks }));
  else for (const check of checks) console.log(check.ok && !check.warning ? `ok ${check.id}` : `${check.ok ? "warn" : "fail"} ${check.id} ${check.fix ?? ""}`);
  if (!ok) process.exitCode = 1;
}

/** `job <type> [args as JSON]`: one job, run by the running connector; prints its reply, exits 1 when it failed. */
async function jobCommand(): Promise<void> {
  const [type, args] = process.argv.slice(3);
  if (!type) throw new Error("usage: mausbot-connector job <type> [args as JSON], e.g. job update '{\"image\":\"ghcr.io/…@sha256:…\"}'");
  let parsed: unknown = {};
  if (args) {
    try { parsed = JSON.parse(args); } catch { throw new Error("the job's arguments are not JSON"); }
  }
  const reply = await sendLocalJob(PATHS.jobs, type, parsed);
  console.log(JSON.stringify(reply));
  if (reply.ok !== true) process.exitCode = 1;
}

/** `audit [--tail N]` prints the newest lines; `audit --verify` checks every line's link to the one before it. */
function auditCommand(): void {
  const audit = auditLog();
  const args = process.argv.slice(3);
  if (args.includes("--verify")) {
    const verdict = verifyAudit(existsSync(audit.file) ? readFileSync(audit.file, "utf8") : "");
    console.log(verdict.ok ? `${audit.file}: ${verdict.lines} lines, each linked to the one before it` : `${audit.file}: line ${verdict.line}: ${verdict.why}`);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  const at = args.indexOf("--tail");
  const count = at >= 0 ? Number(args[at + 1]) : 50;
  for (const line of audit.tail(Number.isInteger(count) && count > 0 ? count : 50)) console.log(line);
}

/** `pause` and `resume`: the server's admin stops and allows MausBot's jobs and requests. The running connector reads it before each one. */
function pauseCommand(paused: boolean): void {
  const state = new StateStore(PATHS.state);
  if (serverMode(state.agent()) !== "customer-run") {
    throw new Error("MausBot runs this server, so there is no remote management to pause here. To cut the connection: docker stop mausbot-connector");
  }
  if (state.paused() !== paused) {
    state.savePause(paused);
    auditLog().append({ event: "management", what: paused ? "paused" : "resumed", by: "local" });
  }
  console.log(paused
    ? "Remote management is paused: this server refuses every job and request from MausBot, and logs each one. It still reports its health. To allow them again: mausbot-connector resume"
    : "Remote management is on again: MausBot may run the jobs this server allows.");
}

const commands: Record<string, () => Promise<void> | void> = {
  run,
  enroll: enrollCommand,
  status: statusCommand,
  probe: probeCommand,
  job: jobCommand,
  audit: auditCommand,
  pause: () => pauseCommand(true),
  resume: () => pauseCommand(false),
  version: () => console.log(CONNECTOR_VERSION),
};

const command = commands[process.argv[2] ?? "run"];
if (!command) {
  console.error("usage: mausbot-connector run | enroll | status | probe [--json] | job <type> [args] | audit [--tail N | --verify] | pause | resume | version");
  process.exitCode = 2;
} else {
  Promise.resolve().then(command).catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
