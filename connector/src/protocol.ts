// MausBot connector protocol v1: what the connector on an own server and the MausBot Cloud Admin say to each other.
// The Admin side copies this file as it is: it imports nothing.
//
// The connector only ever calls out. It enrols once over HTTPS with a one-time code, then holds one WebSocket to the
// Admin and runs the jobs the Admin sends on it; jobs that change the home or the connector run one at a time. There is
// no shell and no other command. Disk transfers are HTTPS, authorized with the same agent token.

export const PROTOCOL_VERSION = 1;

/** `POST {admin}{ENROLL_PATH}` with an `EnrollRequest`; answers an `EnrollResponse`. The code is single use. */
export const ENROLL_PATH = "/api/cloud/servers/agent/enroll";
/** `GET {admin}{CONNECT_PATH}`, upgraded to a WebSocket, with `Authorization: Bearer <agentToken>`. */
export const CONNECT_PATH = "/api/cloud/servers/agent/connect";
/** `PUT {admin}{EXPORT_PATH}/<job id>`, `content-type: application/gzip`: an `export-disk` job's archive of `/data`. */
export const EXPORT_PATH = "/api/cloud/servers/agent/export";

/** The Admin closes the WebSocket with this code when it no longer knows the token: the server was removed. */
export const CLOSE_UNAUTHORIZED = 4401;
/** The Admin closes an older WebSocket with this code when a newer one with the same token connects. */
export const CLOSE_REPLACED = 4409;

/** How often the connector sends a heartbeat while connected. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** An `update` rolls back when the new home does not report its new image within this. */
export const UPDATE_HEALTH_WINDOW_MS = 10 * 60_000;

/** The only images a home may run, and the only ones the connector may become: our registry, pinned by digest. */
export const HOME_IMAGE = /^ghcr\.io\/milind-soni\/openmausbot-cloud-home@sha256:[0-9a-f]{64}$/;
export const CONNECTOR_IMAGE = /^ghcr\.io\/milind-soni\/mausbot-connector@sha256:[0-9a-f]{64}$/;

export interface ConnectorIdentity {
  version: string;
  protocol: typeof PROTOCOL_VERSION;
  /** The image the connector runs, as it was started (a digest reference once it updated itself). */
  image: string | null;
}

/** What the server is, sent at enrolment and in every heartbeat. Sizes are whole numbers. */
export interface HostFacts {
  /** e.g. "Ubuntu 24.04.1 LTS". */
  os: string;
  kernel: string;
  /** `uname -m`: "x86_64". */
  arch: string;
  cpus: number;
  memMb: number;
  /** Free space where Docker keeps its volumes, so where `/data` lives. */
  diskGb: number;
  /** Docker's server version. */
  docker: string;
  /** Docker runs containers under AppArmor. */
  apparmor: boolean;
  /** Unprivileged user namespaces are allowed (the bot box needs them). */
  userns: boolean;
}

export type CheckId = "arch" | "docker" | "rootless" | "apparmor" | "profiles" | "userns" | "box" | "disk" | "memory" | "clock";

/** One pre-check. `fix` is the plain-words line for the server's owner; never a technical cause. */
export interface HostCheck {
  id: CheckId;
  ok: boolean;
  /** A warning still lets MausBot run. */
  warning?: boolean;
  fix?: string;
}

export interface HostHealth extends HostFacts {
  diskTotalGb: number;
  memAvailableMb: number;
  load1: number;
  uptimeS: number;
  /** Seconds the server's clock is ahead of the Admin's (negative: behind); null until measured. */
  clockSkewS: number | null;
  checks: HostCheck[];
}

/** `absent`: never started. `crashed`: exited on its own; the connector starts it again (and says so here meanwhile). */
export type HomeState = "absent" | "stopped" | "starting" | "running" | "crashed" | "updating" | "restoring";

/** The home's own signed health report (`GET /api/cloud/health`), reduced to fixed fields. */
export interface HomeHealth {
  /** The report answered and names the image the home should run. */
  ok: boolean;
  version: string | null;
  image: string | null;
  /** The bot box: its kind, and the self-check's "passed/total" with the failed check ids. */
  box: { box: string | null; checks: string | null; failed: string[] } | null;
  at: number;
}

export interface HomeReport {
  state: HomeState;
  /** The image the home container runs (or ran last). */
  image: string | null;
  health: HomeHealth | null;
}

/** A copy of `/data`: a `backup` job's, or the safety copy taken before an update, a restore or an import. */
export interface CopyInfo {
  id: string;
  kind: "backup" | "snapshot";
  createdAt: number;
  /** The home image that ran on the data when it was copied. */
  image: string | null;
}

/** Connector → Admin, every `HEARTBEAT_INTERVAL_MS` and once right after connecting. */
export interface Heartbeat {
  heartbeat: { host: HostHealth; home: HomeReport; connector: ConnectorIdentity };
}

export interface JobArgs {
  /** Writes the home's environment (kept 0600 on the server) and starts the home on `image`. */
  start: { image: string; env: Record<string, string> };
  stop: Record<string, never>;
  restart: Record<string, never>;
  /** Pull → copy `/data` → swap the container → wait for the new image's health → else roll back image and data. */
  update: { image: string };
  status: Record<string, never>;
  backup: Record<string, never>;
  restore: { backupId: string };
  /** Uploads a gzip tar of `/data` to `PUT {admin}{EXPORT_PATH}/<job id>`. */
  "export-disk": Record<string, never>;
  /** Replaces `/data` with the gzip tar at `url` (https; the agent token is sent only to the Admin's own origin). */
  "import-disk": { url: string };
  "host-health": Record<string, never>;
  /** Swaps the connector itself for `image`, keeping the current one until the new one has connected. */
  "self-update": { image: string };
}

export type JobType = keyof JobArgs;
export const JOB_TYPES: readonly JobType[] = ["start", "stop", "restart", "update", "status", "backup", "restore", "export-disk", "import-disk", "host-health", "self-update"];

/** Admin → connector. `id` is the Admin's; a job sent again with the same id is answered again, never run twice. */
export interface Job<T extends JobType = JobType> {
  id: string;
  type: T;
  args: JobArgs[T];
}

export interface JobResults {
  start: { home: HomeReport };
  stop: { home: HomeReport };
  restart: { home: HomeReport };
  update: { home: HomeReport; previousImage: string | null; snapshot: CopyInfo | null };
  status: { home: HomeReport; connector: ConnectorIdentity; backups: CopyInfo[]; snapshot: CopyInfo | null };
  backup: { backup: CopyInfo };
  restore: { home: HomeReport; backupId: string };
  "export-disk": { bytes: number; sha256: string };
  "import-disk": { home: HomeReport; bytes: number };
  "host-health": { host: HostHealth };
  "self-update": { connector: ConnectorIdentity };
}

export type JobErrorCode =
  | "invalid_job" | "unknown_job" | "invalid_args" | "busy" | "interrupted"
  | "no_home" | "docker" | "pull_failed" | "unhealthy" | "update_rolled_back" | "rollback_failed"
  | "not_found" | "disk_full" | "port_in_use" | "box_unavailable" | "transfer_failed" | "self_update_failed";

/** `message` is plain words for the Admin's log and alerts; it never carries a secret. */
export interface JobError {
  code: JobErrorCode;
  message: string;
  /** `update_rolled_back`: the image the home runs again. */
  image?: string;
}

/**
 * Connector → Admin, once per job, then again on every new connection until the Admin acknowledges it (`JobAck`): a
 * reply written just before a connection died is not lost. The Admin keeps the first reply to an id and ignores repeats.
 */
export type JobReply<T extends JobType = JobType> = { id: string; ok: true; result: JobResults[T] } | { id: string; ok: false; error: JobError };

/** Admin → connector, once it has stored the reply to job `ack`. */
export interface JobAck {
  ack: string;
}

/** `POST {admin}{ENROLL_PATH}` body. */
export interface EnrollRequest {
  code: string;
  host: HostFacts;
  connector: ConnectorIdentity;
}

export interface EnrollResponse {
  serverId: string;
  cloudId: string;
  agentToken: string;
}

// Validation, shared so both sides refuse the same things.

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_.~-]{32,512}$/;
const ENV_NAME = /^OMB_[A-Z0-9_]{1,60}$/;
// oxlint-disable-next-line no-control-regex
const ENV_VALUE = /^[^\0\r\n]{0,8192}$/;
const MAX_ENV = 64;

/** The home's boot contract: without these the home refuses to start. */
export const REQUIRED_HOME_ENV = ["OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_PUBLIC_URL", "OMB_CLOUD_BOOTSTRAP_SECRET"] as const;

/** Settings the image owns, or that make sense only on Fly; a home on an own server never takes them from outside. */
export const REFUSED_HOME_ENV = new Set([
  "OMB_CLOUD_EDGE_HOLD", "OMB_CLOUD_EDGE_BIN", "OMB_CLOUD_EDGE_CONFIG", "OMB_CLOUD_HARDEN",
  "OMB_DATA_DIR", "OMB_STATIC_DIR", "OMB_DUCKDB_DIR", "OMB_PORT", "OMB_WEBHOOK_PORT", "OMB_CLOUD_SECRETS_FD",
]);

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function noArgs(args: Record<string, unknown>): Checked<Record<string, never>> {
  return Object.keys(args).length === 0 ? { ok: true, value: {} } : { ok: false, message: "this job takes no arguments" };
}

function only(args: Record<string, unknown>, keys: string[]): string | null {
  const extra = Object.keys(args).filter((key) => !keys.includes(key));
  return extra.length ? `unknown argument ${JSON.stringify(extra[0])}` : null;
}

function httpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (value === url.origin || value === `${url.origin}/`);
  } catch {
    return false;
  }
}

/** The home's environment: names are `OMB_*` and never one the image owns; values are one line. Never echoes a value. */
export function checkHomeEnv(env: unknown): Checked<Record<string, string>> {
  if (!plainObject(env)) return { ok: false, message: "env must be an object of names and values" };
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV) return { ok: false, message: `env has more than ${MAX_ENV} names` };
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) return { ok: false, message: `env name ${JSON.stringify(name.slice(0, 64))} is not an OMB_ setting` };
    if (REFUSED_HOME_ENV.has(name)) return { ok: false, message: `env name ${name} is the image's own setting` };
    if (typeof value !== "string" || !ENV_VALUE.test(value)) return { ok: false, message: `env value of ${name} must be one line of at most 8192 characters` };
  }
  for (const name of REQUIRED_HOME_ENV) if (typeof env[name] !== "string" || !env[name]) return { ok: false, message: `env must set ${name}` };
  if (env.OMB_CLOUD_ROLE !== "home" && env.OMB_CLOUD_ROLE !== "team") return { ok: false, message: 'OMB_CLOUD_ROLE must be "home" or "team"' };
  if (!httpsOrigin(env.OMB_PUBLIC_URL as string)) return { ok: false, message: "OMB_PUBLIC_URL must be an https origin" };
  if (!httpsOrigin(env.OMB_CLOUD_ADMIN_URL as string)) return { ok: false, message: "OMB_CLOUD_ADMIN_URL must be an https origin" };
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

/** An https URL (or, for a test Admin, http on this machine's loopback) without credentials in it. */
export function checkTransferUrl(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.length > 4096) return { ok: false, message: "url must be a string of at most 4096 characters" };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, message: "url is not a URL" }; }
  if (url.username || url.password) return { ok: false, message: "url must not carry credentials" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return { ok: false, message: "url must be https" };
  return { ok: true, value: url.href };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** A whole Admin → connector message: a job with a valid id, a known type and exactly that type's arguments. */
export function checkJob(message: unknown): { ok: true; job: Job } | { ok: false; id: string | null; code: "invalid_job" | "unknown_job" | "invalid_args"; message: string } {
  if (!plainObject(message)) return { ok: false, id: null, code: "invalid_job", message: "a job is a JSON object" };
  const id = typeof message.id === "string" && JOB_ID.test(message.id) ? message.id : null;
  if (!id) return { ok: false, id: null, code: "invalid_job", message: "a job needs an id of 1 to 64 letters, digits, - or _" };
  if (typeof message.type !== "string" || !(JOB_TYPES as readonly string[]).includes(message.type)) {
    return { ok: false, id, code: "unknown_job", message: `unknown job type ${JSON.stringify(String(message.type).slice(0, 32))}` };
  }
  const type = message.type as JobType;
  const args = message.args === undefined ? {} : message.args;
  if (!plainObject(args)) return { ok: false, id, code: "invalid_args", message: "args must be an object" };
  const checked = checkArgs(type, args);
  if (!checked.ok) return { ok: false, id, code: "invalid_args", message: checked.message };
  return { ok: true, job: { id, type, args: checked.value } as Job };
}

function checkArgs(type: JobType, args: Record<string, unknown>): Checked<JobArgs[JobType]> {
  switch (type) {
    case "start": {
      const extra = only(args, ["image", "env"]);
      if (extra) return { ok: false, message: extra };
      if (typeof args.image !== "string" || !HOME_IMAGE.test(args.image)) return { ok: false, message: "image must be ghcr.io/milind-soni/openmausbot-cloud-home@sha256:<digest>" };
      const env = checkHomeEnv(args.env);
      return env.ok ? { ok: true, value: { image: args.image, env: env.value } } : env;
    }
    case "update": {
      const extra = only(args, ["image"]);
      if (extra) return { ok: false, message: extra };
      if (typeof args.image !== "string" || !HOME_IMAGE.test(args.image)) return { ok: false, message: "image must be ghcr.io/milind-soni/openmausbot-cloud-home@sha256:<digest>" };
      return { ok: true, value: { image: args.image } };
    }
    case "self-update": {
      const extra = only(args, ["image"]);
      if (extra) return { ok: false, message: extra };
      if (typeof args.image !== "string" || !CONNECTOR_IMAGE.test(args.image)) return { ok: false, message: "image must be ghcr.io/milind-soni/mausbot-connector@sha256:<digest>" };
      return { ok: true, value: { image: args.image } };
    }
    case "restore": {
      const extra = only(args, ["backupId"]);
      if (extra) return { ok: false, message: extra };
      if (typeof args.backupId !== "string" || !BACKUP_ID.test(args.backupId)) return { ok: false, message: "backupId must be a backup's id" };
      return { ok: true, value: { backupId: args.backupId } };
    }
    case "import-disk": {
      const extra = only(args, ["url"]);
      if (extra) return { ok: false, message: extra };
      const url = checkTransferUrl(args.url);
      return url.ok ? { ok: true, value: { url: url.value } } : url;
    }
    default:
      return noArgs(args);
  }
}

export function checkEnrollResponse(value: unknown): Checked<EnrollResponse> {
  if (!plainObject(value)) return { ok: false, message: "the enrolment answer is not a JSON object" };
  const { serverId, cloudId, agentToken } = value;
  if (typeof serverId !== "string" || !OPAQUE_ID.test(serverId)) return { ok: false, message: "the enrolment answer has no valid serverId" };
  if (typeof cloudId !== "string" || !OPAQUE_ID.test(cloudId)) return { ok: false, message: "the enrolment answer has no valid cloudId" };
  if (typeof agentToken !== "string" || !TOKEN.test(agentToken)) return { ok: false, message: "the enrolment answer has no valid agentToken" };
  return { ok: true, value: { serverId, cloudId, agentToken } };
}

/** A one-time code as the Admin shows it: letters, digits and dashes. */
export function checkEnrollCode(value: unknown): Checked<string> {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/.test(value)
    ? { ok: true, value }
    : { ok: false, message: "the code is the one-time code MausBot shows next to the install command" };
}
