// A customer-run server: everything MausBot's control plane (the Admin) may run on it, ask of it and learn from it.
// This one file is the whole list, for a security reviewer to read. The connector enforces it on the server itself,
// whatever the Admin sends: a job, a request or a reported field that is not written here does not exist in this mode.
//
// Security invariant: nothing in this file passes through text a person wrote. Every string that leaves is either a
// constant below, an enumerated code, or matches one of the patterns below (a version, an image reference, an id).
import {
  checkJob, type CheckId, type ConnectorIdentity, type CopyInfo, type Heartbeat, type HomeHealth, type HomeReport, type HostFacts, type HomeState, type HostHealth,
  type Job, type JobError, type JobErrorCode, type JobReply, type JobType,
} from "./protocol.ts";

// 1. JOBS. The only kinds the Admin may run. Not here, so refused: `export-disk` (uploads the data to MausBot) and
// `import-disk` (replaces the data with an archive from elsewhere).

export const CUSTOMER_RUN_JOBS = ["start", "stop", "restart", "update", "status", "host-health", "backup"] as const satisfies readonly JobType[];

/**
 * Kinds only root on the server may run (`mausbot-connector job <kind>`), never the Admin:
 * - `self-update` replaces the connector, and with it every rule in this file. An older connector does not know this
 *   mode at all, so the Admin asking for one would undo the mode. The owner replaces the connector, or nobody does.
 * - `restore` puts older data back over what is there.
 */
export const CUSTOMER_RUN_LOCAL_JOBS = ["self-update", "restore"] as const satisfies readonly JobType[];

/**
 * What each job may carry.
 * - `start`, `stop`, `restart`: nothing. They start and stop the server its owner installed, with the owner's settings;
 *   a `start` that names an image or settings is refused.
 * - `update`: the image to move to, MausBot's own server image pinned by digest, and never an older version than the
 *   one running (below). The server's own updater does it.
 * - `backup`: nothing. Copies the data to a Docker volume on this server; it never removes a copy the owner made.
 * - `status`, `host-health`: nothing. They read.
 */
export const CUSTOMER_HOME_IMAGE = /^ghcr\.io\/milind-soni\/openmausbot@sha256:[0-9a-f]{64}$/;

/** Who sent a job: the Admin over the connection, or root on this server. */
export type JobSource = "admin" | "local";

const allowed = (type: unknown, by: JobSource): boolean =>
  (CUSTOMER_RUN_JOBS as readonly unknown[]).includes(type) || (by === "local" && (CUSTOMER_RUN_LOCAL_JOBS as readonly unknown[]).includes(type));

/** Why this server refuses a job of `type` sent by `by`, or null when the kind is on that sender's list. */
export function customerRunRefusal(type: string, by: JobSource): string | null {
  if (allowed(type, by)) return null;
  if (allowed(type, "local")) return `This server is run by its owner, and only they may run ${type} here: sudo docker exec mausbot-connector mausbot-connector job ${type}`;
  return `This server is run by its owner, and ${JSON.stringify(type.slice(0, 32))} is not a job that may run on it.`;
}

/**
 * An `update` never moves the server to an older version than the one it runs, and never below this one. Checked on
 * the image's own version label, once in the connector and again by the updater's runner on the server, which is the
 * one that counts. The owner goes back with `./update.sh --rollback` or `--version` on the server, never the Admin.
 * Raise this to the first release that carries the hardened profile when that release exists.
 */
export const SERVER_VERSION_FLOOR = "0.0.0";
export const VERSION_LABEL = "org.opencontainers.image.version";

/** "v0.1.130" → [0, 1, 130]; null for anything that is not a released version. */
export function releasedVersion(label: unknown): [number, number, number] | null {
  const match = typeof label === "string" ? /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(label) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const older = (a: readonly number[], b: readonly number[]) => a[0] !== b[0] ? a[0]! < b[0]! : a[1] !== b[1] ? a[1]! < b[1]! : a[2]! < b[2]!;

/** Why an image labelled `next` may not replace one labelled `current`, or null. An image that names no version is refused. */
export function olderVersionRefusal(next: unknown, current: unknown, floor: string = SERVER_VERSION_FLOOR): string | null {
  const wanted = releasedVersion(next);
  if (!wanted) return "The image does not say which version it is.";
  const least = releasedVersion(floor);
  if (least && older(wanted, least)) return `Version ${wanted.join(".")} is older than ${least.join(".")}, the oldest this server accepts.`;
  const running = releasedVersion(current);
  if (running && older(wanted, running)) return `Version ${wanted.join(".")} is older than ${running.join(".")}, which runs here.`;
  return null;
}

type CheckedJob = { ok: true; job: Job } | { ok: false; id: string | null; code: "invalid_job" | "unknown_job" | "invalid_args" | "refused_by_mode"; message: string };

/** A whole job message for a customer-run server: a listed kind with exactly that kind's arguments. */
export function checkCustomerRunJob(message: unknown, by: JobSource): CheckedJob {
  const fields = typeof message === "object" && message !== null && !Array.isArray(message) ? message as Record<string, unknown> : {};
  const { id, type } = fields;
  if (typeof type === "string" && !allowed(type, by)) {
    const known = typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
    return { ok: false, id: known, code: "refused_by_mode", message: customerRunRefusal(type, by)! };
  }
  if (type !== "start" && type !== "update") return checkJob(message);
  const args = fields.args === undefined ? {} : fields.args;
  const shape = checkJob({ id, type: "stop", args: {} });
  if (!shape.ok) return shape;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, id: shape.job.id, code: "invalid_args", message: "args must be an object" };
  const keys = Object.keys(args);
  if (type === "start") {
    return keys.length === 0
      ? { ok: true, job: { id: shape.job.id, type, args: {} } as unknown as Job }
      : { ok: false, id: shape.job.id, code: "refused_by_mode", message: "This server is run by its owner: MausBot may start it, but not choose its image or its settings." };
  }
  const image = (args as Record<string, unknown>).image;
  if (keys.length !== 1 || typeof image !== "string" || !CUSTOMER_HOME_IMAGE.test(image)) {
    return { ok: false, id: shape.job.id, code: "invalid_args", message: "image must be ghcr.io/milind-soni/openmausbot@sha256:<digest>" };
  }
  return { ok: true, job: { id: shape.job.id, type, args: { image } } };
}

// 2. REQUESTS. The Admin can also open streams that carry one HTTP request each. On a customer-run server none of them
// reaches the home: the connector answers these four itself, from the facts in section 3, and refuses every other
// method and path, and any request with a body. There is no pairing, so the Admin cannot open a sign-in.

export const CUSTOMER_RUN_REQUESTS = {
  /** `{ state, ok }`: the home's state, and whether it answers. */
  "GET /v1/health": "health",
  /** `{ home, connector }`: the two versions. */
  "GET /v1/version": "version",
  /** `{ seats }`: how many people can sign in. A number, or null when the home does not say. */
  "GET /v1/seats": "seats",
  /** `{ state, image, previousImage }`: whether an update is running, and the images before and after the last one. */
  "GET /v1/update": "update",
} as const;

export type CustomerRunRequest = (typeof CUSTOMER_RUN_REQUESTS)[keyof typeof CUSTOMER_RUN_REQUESTS];

export function customerRunRequest(method: string, target: string): CustomerRunRequest | null {
  const known = CUSTOMER_RUN_REQUESTS as Record<string, CustomerRunRequest>;
  const key = `${method} ${target}`;
  return Object.hasOwn(known, key) ? known[key]! : null;
}

/** What the connector knows of the server to answer with: all of it is in the heartbeat too. */
export interface ServerFacts {
  home: HomeReport;
  connector: ConnectorIdentity;
  seats: number | null;
  previousImage: string | null;
}

export function answerCustomerRunRequest(request: CustomerRunRequest, facts: ServerFacts): Record<string, unknown> {
  const home = reducedHome(facts.home);
  switch (request) {
    case "health": return { state: home.state, ok: home.health?.ok === true };
    case "version": return { home: home.health?.version ?? null, connector: versionOrNull(facts.connector.version) };
    case "seats": return { seats: seatsOrNull(facts.seats) };
    case "update": return { state: home.state, image: home.image, previousImage: imageOrNull(facts.previousImage) };
  }
}

// 3. WHAT THE CONNECTOR READS FROM THE HOME. Three GETs on the home's own loopback, with no body, and from them four
// fields: that it answers as MausBot and whether its bot box is on or off, its version, and its seat count. Every other field of those answers (the
// server's name among them) is dropped here and never kept.

export const HOME_READS = ["/api/health", "/.well-known/openmausbot/environment", "/api/seats"] as const;
const RECORD_END = "\u001e";
/** Run inside the home's container: curl comes with the image, and the home listens on its own loopback only. */
export const HOME_READS_COMMAND = [
  "sh", "-c",
  `for path in ${HOME_READS.join(" ")}; do curl -s --max-time 5 "http://127.0.0.1:\${OMB_PORT:-8799}$path" || true; printf '\\n\\036\\n'; done`,
] as const;

export interface HomeFacts {
  answers: boolean;
  version: string | null;
  seats: number | null;
  /** Whether its bots run in the bot box, from the health answer: on, off, or null when it does not say. */
  box: "on" | "off" | null;
}

const parsed = (text: string | undefined): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export function parseHomeReads(output: string): HomeFacts {
  const [health, environment, seats] = output.split(RECORD_END);
  const said = parsed(health);
  return { answers: said.app === "openmausbot", version: versionOrNull(parsed(environment).version), seats: seatsOrNull(parsed(seats).seats), box: boxOnOff(said.box) };
}

// 4. WHAT LEAVES THE SERVER. The heartbeat (every 30 seconds) and each job's reply, rebuilt here field by field. A
// field that is not copied below is not sent. No name, no address, no file name, no log line.

const VERSION = /^v?\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.]{1,32})?$/;
const IMAGE = /^ghcr\.io\/milind-soni\/(?:openmausbot|mausbot-connector)(?:@sha256:[0-9a-f]{64}|:[0-9A-Za-z][0-9A-Za-z._-]{0,63})$/;
/** An operating system, kernel or Docker version as the machine names itself: letters, digits and version punctuation. */
const MACHINE = /^[0-9A-Za-z][0-9A-Za-z ._:+~()/#-]{0,79}$/;
const COPY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHECK_IDS: readonly CheckId[] = ["arch", "docker", "rootless", "apparmor", "profiles", "userns", "box", "disk", "memory", "clock"];
const HOME_STATES: readonly HomeState[] = ["absent", "stopped", "starting", "running", "crashed", "updating", "restoring"];

const versionOrNull = (value: unknown) => (typeof value === "string" && VERSION.test(value) ? value : null);
const imageOrNull = (value: unknown) => (typeof value === "string" && IMAGE.test(value) ? value : null);
const machine = (value: unknown) => (typeof value === "string" && MACHINE.test(value) ? value : "unknown");
const count = (value: unknown, max = 1e15) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : 0);
const boxOnOff = (value: unknown) => (value === "on" || value === "off" ? value : null);
/** The bot box as a customer-run server reports it: on or off, never its checks. */
export const boxReport = (value: unknown): HomeHealth["box"] => {
  const said = boxOnOff(value);
  return said ? { box: said, checks: null, failed: [] } : null;
};
const seatsOrNull = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null);

/** The server's facts as they leave it, at enrolment and in every heartbeat. */
export function reducedFacts(host: HostFacts): HostFacts {
  return {
    os: machine(host.os), kernel: machine(host.kernel), arch: machine(host.arch), cpus: count(host.cpus), memMb: count(host.memMb), diskGb: count(host.diskGb),
    docker: machine(host.docker), apparmor: host.apparmor === true, userns: host.userns === true,
  };
}

function reducedHost(host: HostHealth): HostHealth {
  return {
    ...reducedFacts(host),
    diskTotalGb: count(host.diskTotalGb), memAvailableMb: count(host.memAvailableMb), load1: count(host.load1), uptimeS: count(host.uptimeS),
    clockSkewS: typeof host.clockSkewS === "number" && Number.isFinite(host.clockSkewS) ? host.clockSkewS : null,
    // The check's id and verdict. The sentence that tells the owner how to fix it stays on the server (`probe`).
    checks: (host.checks ?? []).filter((check) => CHECK_IDS.includes(check.id)).map((check) => ({ id: check.id, ok: check.ok === true, ...(check.warning ? { warning: true } : {}) })),
  };
}

function reducedHome(home: HomeReport): HomeReport {
  const health = home.health;
  return {
    state: HOME_STATES.includes(home.state) ? home.state : "absent",
    image: imageOrNull(home.image),
    health: health ? { ok: health.ok === true, version: versionOrNull(health.version), image: imageOrNull(health.image), box: boxReport(health.box?.box), at: count(health.at) } : null,
  };
}

const reducedConnector = (connector: ConnectorIdentity): ConnectorIdentity => ({ version: versionOrNull(connector.version) ?? "0.0.0", protocol: connector.protocol, image: imageOrNull(connector.image) });

const reducedCopy = (copy: CopyInfo): CopyInfo => ({
  id: COPY_ID.test(copy.id) ? copy.id : "unknown", kind: copy.kind === "snapshot" ? "snapshot" : "backup", createdAt: count(copy.createdAt), image: imageOrNull(copy.image),
});

export function reducedHeartbeat(facts: { host: HostHealth; home: HomeReport; connector: ConnectorIdentity; paused: boolean; seats: number | null }): Heartbeat {
  return {
    heartbeat: {
      host: reducedHost(facts.host), home: reducedHome(facts.home), connector: reducedConnector(facts.connector),
      mode: "customer-run", paused: facts.paused === true, seats: seatsOrNull(facts.seats),
    },
  };
}

/** A failed job's reply names its code; this sentence goes with it. What Docker or the home said stays in the audit log. */
const FAILURES: Record<JobErrorCode, string> = {
  invalid_job: "The job was malformed.",
  unknown_job: "The connector does not know this kind of job.",
  invalid_args: "The job's arguments were not the ones this kind of job takes.",
  busy: "Too many jobs are waiting on this server, or its updater is already running.",
  interrupted: "The job was interrupted and finished safely.",
  audit_unavailable: "The audit log on the server cannot be written, so nothing was done.",
  refused_by_policy: "The server's policy file does not allow this job.",
  refused_by_mode: "This server is run by its owner, and this is not a job MausBot may run on it.",
  paused: "The server's admin has paused remote management.",
  image_refused: "The image was refused. Nothing was changed.",
  no_home: "MausBot is not installed on this server.",
  docker: "Docker on the server could not do this.",
  pull_failed: "The image could not be downloaded. Nothing was changed.",
  unhealthy: "The server did not become healthy.",
  update_rolled_back: "The new version did not become healthy. The previous version and its data are back.",
  rollback_failed: "The update failed and the previous version did not come back healthy either.",
  update_unavailable: "The server's own updater is not installed, so MausBot cannot update it.",
  update_not_started: "The server's own updater did not start the update. Nothing was changed.",
  older_version: "The image is older than the version the server runs, or names no version. Nothing was changed.",
  not_found: "There is no such backup on this server.",
  disk_full: "There is not enough free disk on the server for a safety copy of the data.",
  port_in_use: "A port the server needs is used by another program.",
  box_unavailable: "The bot box's security profiles are not installed on this server.",
  transfer_failed: "A transfer failed.",
  self_update_failed: "The connector could not replace itself and was not changed.",
  unsigned_job: "The job was not signed by MausBot.",
  wrong_box: "The job was signed for another server.",
  expired_job: "The job's signature was too old.",
  pending_box: "The team's Owner has not accepted this server in MausBot yet.",
};
const AUDIT_HINT = " The server's admin can read the reason with: mausbot-connector audit";

function reducedError(error: JobError): JobError {
  const code: JobErrorCode = Object.hasOwn(FAILURES, error.code) ? error.code : "docker";
  const image = imageOrNull(error.image);
  return { code, message: `${FAILURES[code]}${AUDIT_HINT}`, ...(image ? { image } : {}) };
}

/** A job's reply as it leaves a customer-run server: the fields below, and nothing else the job produced. */
export function reducedReply(reply: JobReply): JobReply {
  if (!reply.ok) return { id: reply.id, ok: false, error: reducedError(reply.error) };
  const result = reply.result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (result.home) out.home = reducedHome(result.home as HomeReport);
  if (result.host) out.host = reducedHost(result.host as HostHealth);
  if (result.connector) out.connector = reducedConnector(result.connector as ConnectorIdentity);
  if (Array.isArray(result.backups)) out.backups = (result.backups as CopyInfo[]).map(reducedCopy);
  if (result.backup) out.backup = reducedCopy(result.backup as CopyInfo);
  if ("snapshot" in result) out.snapshot = result.snapshot ? reducedCopy(result.snapshot as CopyInfo) : null;
  if ("previousImage" in result) out.previousImage = imageOrNull(result.previousImage);
  if (typeof result.backupId === "string" && COPY_ID.test(result.backupId)) out.backupId = result.backupId;
  return { id: reply.id, ok: true, result: out } as JobReply;
}
