// mausbot-connector: `run` (the service), `enroll` (the code on stdin), `status`, `probe`, `job` (one job from root on this
// server), `audit` (the audit log, checked), `version`.
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";

import { Agent } from "./agent.ts";
import { AuditLog, verifyAudit } from "./audit.ts";
import { SocketDocker, type DockerInfo } from "./docker.ts";
import { adminOrigin, enroll } from "./enroll.ts";
import { readHealth } from "./home-health.ts";
import { Home } from "./home.ts";
import { hostChecks, hostFacts, hostHealth, probeBox, type BoxProbeResult, type HostReader } from "./host.ts";
import { jobDesk, jobRunner, resultEvent } from "./jobs.ts";
import { sendLocalJob, serveLocalJobs } from "./local.ts";
import { POLICY_FILE } from "./policy.ts";
import { errorText, log, registerSecret } from "./log.ts";
import { PROTOCOL_VERSION, type ConnectorIdentity, type Heartbeat, type HostHealth } from "./protocol.ts";
import { SELF_UPDATE_DEADLINE_MS, SelfUpdater, ownContainer } from "./self-update.ts";
import { AUDIT_FILE, CONNECTOR_VERSION, PATHS, SECCOMP_FILE, envSeconds } from "./settings.ts";
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

function seccomp(): string {
  const text = reader.installedSeccomp();
  if (!text) throw new Error(`The bot box's seccomp profile is missing from ${PATHS.hostConfig}. Run the install command again to repair it.`);
  return text;
}

/** What the host reports, with Docker's info read again at most every five minutes and the box probed every six hours. */
function hostReporter(docker: SocketDocker, admin: () => string | null) {
  let info: { at: number; value: DockerInfo } | null = null;
  let box: { at: number; value: BoxProbeResult | null } | null = null;
  let clock: { at: number; skew: number | null } | null = null;
  const dockerInfo = async (fresh: boolean) => {
    if (fresh || !info || Date.now() - info.at > 5 * 60_000) info = { at: Date.now(), value: await docker.info() };
    return info.value;
  };
  const probe = async (fresh: boolean) => {
    const image = process.env.MAUSBOT_CONNECTOR_IMAGE;
    if (!image) return null;
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
      return hostHealth(value, reader, { clockSkewS: skewed, box: boxed });
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
  let record: AgentRecord | null = state.agent();
  if (!record) log("waiting for this server to be connected: run the install command with the code MausBot shows");
  const enrolledNow = !record;
  while (!record) {
    await sleep(2_000);
    record = state.agent();
  }
  registerSecret(record.agentToken);
  let current: AgentRecord = record;
  if (enrolledNow) note({ event: "connector", what: "enrolled", version: CONNECTOR_VERSION, image: identity().image, serverId: record.serverId });
  const host = hostReporter(docker, () => current.admin);
  const home = new Home({
    docker, state, log, readHealth, seccomp, transfer: httpTransfer,
    diskFree: () => reader.disk().free,
    updateWindowMs: envSeconds("MAUSBOT_UPDATE_WAIT_S", 600, 60, 3600) * 1000,
    onStep: ({ id, type, step, detail }) => note({ event: "step", id, type, step, ...(detail ? { detail } : {}) }),
  });
  const updater = new SelfUpdater({ docker, state, log, instance, identity });
  const heartbeat = async (): Promise<Heartbeat> => {
    await home.refreshHealth().catch(() => null);
    return { heartbeat: { host: await host.health(false), home: await home.report(), connector: identity() } };
  };
  let agent: Agent;
  const runner = jobRunner({
    home,
    hostHealth: () => host.health(true),
    identity,
    admin: () => ({ origin: current.admin, token: current.agentToken }),
    selfUpdate: (job) => home.exclusive(() => updater.run(job, { pause: () => agent.stop(), resume: () => agent.start() })),
  });
  const desk = jobDesk({ run: runner, audit, log, policyFile: join(PATHS.hostConfig, POLICY_FILE) });
  const makeAgent = (from: AgentRecord) => new Agent({ admin: from.admin, token: from.agentToken, log, heartbeat, handle: (job) => desk.submit(job, "admin"), status: (patch) => state.saveStatus(patch) });
  agent = makeAgent(current);

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
  await serveLocalJobs(PATHS.jobs, desk, log).catch((error) => log(`jobs from this server are off: ${errorText(error)}`));

  setInterval(() => {
    home.supervise().catch((error) => log(`supervising the home failed: ${errorText(error)}`));
    const latest = state.agent();
    if (latest && latest.agentToken !== current.agentToken) {
      log("this server was connected again with a new code; reconnecting");
      registerSecret(latest.agentToken);
      current = latest;
      note({ event: "connector", what: "enrolled", version: CONNECTOR_VERSION, image: identity().image, serverId: latest.serverId });
      agent.stop();
      agent = makeAgent(current);
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
  const record = await enroll({ admin, code, host: hostFacts(await docker.info(), reader), connector: identity() });
  state.saveAgent(record);
  // Connected again only once the service has connected with this token.
  state.saveStatus({ connected: false, unauthorized: false, lastError: null });
  console.log(`This server is connected to MausBot (server ${record.serverId}).`);
}

function statusCommand(): void {
  const state = new StateStore(PATHS.state);
  const record = state.agent();
  const status = state.status();
  const home = state.home();
  console.log(JSON.stringify({
    enrolled: Boolean(record), admin: record?.admin ?? null, serverId: record?.serverId ?? null, cloudId: record?.cloudId ?? null,
    connected: status.connected, unauthorized: status.unauthorized, lastConnectedAt: status.lastConnectedAt, lastHeartbeatAt: status.lastHeartbeatAt,
    lastError: status.lastError, home: { desired: home.desired, image: home.image, operation: home.operation?.type ?? null },
  }));
}

/** One line per check for install.sh: `ok <id>`, `warn <id> <fix>` or `fail <id> <fix>`; exits 1 when any fails. */
async function probeCommand(): Promise<void> {
  const docker = new SocketDocker(PATHS.docker);
  const image = process.env.MAUSBOT_CONNECTOR_IMAGE;
  let box: BoxProbeResult | null = null;
  try { box = image ? await probeBox(docker, image, seccomp()) : null; } catch (error) { box = { ok: false, fix: errorText(error) }; }
  const checks = hostChecks(await docker.info(), reader, { clockSkewS: null, box });
  for (const check of checks) console.log(check.ok && !check.warning ? `ok ${check.id}` : `${check.ok ? "warn" : "fail"} ${check.id} ${check.fix ?? ""}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
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

const commands: Record<string, () => Promise<void> | void> = {
  run,
  enroll: enrollCommand,
  status: statusCommand,
  probe: probeCommand,
  job: jobCommand,
  audit: auditCommand,
  version: () => console.log(CONNECTOR_VERSION),
};

const command = commands[process.argv[2] ?? "run"];
if (!command) {
  console.error("usage: mausbot-connector run | enroll | status | probe | job <type> [args] | audit [--tail N | --verify] | version");
  process.exitCode = 2;
} else {
  Promise.resolve().then(command).catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
