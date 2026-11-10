// MausBot connector protocol v2: what the connector on an own server (a "box") and the MausBot Cloud Admin say to each
// other. The Admin side copies this file as it is: it imports nothing.
//
// The connector only ever calls out. It enrols once over HTTPS with a one-time code, sending the public half of an
// Ed25519 key it made and keeps; the Admin answers with its own signing keys, which the connector pins. Then it holds
// one WebSocket to the Admin. Each connection starts with both sides proving their keys (`authText`, `HelloPayload`),
// and the connector's count of its connections, which only goes up: a count the Admin has seen before means a copy of
// the key, and the Admin revokes it. Text messages carry JSON: jobs signed by the Admin for this box only, their
// replies, heartbeats and the Admin's signed schedule and policy. Binary messages carry yamux frames (yamux.ts, the
// phone relay's profile): the Admin opens a stream per HTTP request to the home, and the connector pipes it to the
// home's edge on this server and nowhere else. There is no shell and no other command. Disk transfers are HTTPS,
// authorized with a short token the connector signs (`TransferPayload`).

export const PROTOCOL_VERSION = 2;

/**
 * Who runs the server. `operated`: MausBot does (a Team Cloud on a server we manage), and the connector does whatever
 * the Admin signs. `customer-run`: its owner does; the connector then runs only the jobs, answers only the requests and
 * reports only the fields listed in customer-run.ts, whatever the Admin sends. The mode is chosen on the server when
 * it enrols and kept there; the Admin is told it (`EnrollRequest.mode`, `Heartbeat`) and can never change it.
 */
export type ServerMode = "operated" | "customer-run";

/** `POST {admin}{ENROLL_PATH}` with an `EnrollRequest`; answers an `EnrollResponse`. The code is single use. */
export const ENROLL_PATH = "/api/cloud/box/v1/enroll";
/** `GET {admin}{CONNECT_PATH}`, upgraded to a WebSocket with subprotocol `CHANNEL_PROTOCOL` and header `x-omb-box`. */
export const CONNECT_PATH = "/api/cloud/box/v1/connect";
export const CHANNEL_PROTOCOL = "omb-box.v2";
export const BOX_HEADER = "x-omb-box";
/** `PUT {admin}{EXPORT_PATH}/<job id>`, `content-type: application/gzip`: an `export-disk` job's archive of `/data`. */
export const EXPORT_PATH = "/api/cloud/box/v1/export";
/** `Authorization: Box <envelope>` on a transfer to or from the Admin: a `TransferPayload` the box signed. */
export const TRANSFER_SCHEME = "Box";

/** The Admin closes the WebSocket with this code when it does not know the box's key, or the key was revoked. */
export const CLOSE_UNAUTHORIZED = 4401;
/** The Admin saw a second server with this box's key (a connection count it had seen before) and revoked the key. */
export const CLOSE_KEY_COPIED = 4403;
/** The Admin closes an older WebSocket with this code when a newer one of the same box connects. */
export const CLOSE_REPLACED = 4409;
/** Either side: a message out of order or malformed, a yamux error, or a key that does not verify. */
export const CLOSE_PROTOCOL = 4000;
/** Either side: nothing arrived for `CHANNEL_DEAD_MS`. */
export const CLOSE_SILENT = 4002;

/** Each side sends a yamux ping this often; a connection with nothing received for `CHANNEL_DEAD_MS` is dropped. */
export const CHANNEL_PING_MS = 20_000;
export const CHANNEL_DEAD_MS = 90_000;
/** How long either side waits for the other's half of the handshake. */
export const HANDSHAKE_MS = 60_000;
/** A signed job is refused this long after the Admin signed it (by the Admin's clock, which the hello carries). */
export const JOB_LIFETIME_MS = 15 * 60_000;
/** A transfer token lasts this long; an upload or download only has to start within it. */
export const TRANSFER_TOKEN_MS = 10 * 60_000;

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
  heartbeat: {
    host: HostHealth;
    home: HomeReport;
    connector: ConnectorIdentity;
    /** Only from a customer-run server; absent means `operated`. */
    mode?: "customer-run";
    /** Customer-run only: the server's admin has paused remote management, so every job and request is refused. */
    paused?: boolean;
    /** Customer-run only: how many people can sign in to the home; null when the home does not say. Never who. */
    seats?: number | null;
  };
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
  /** Replaces `/data` with the gzip tar at `url` (https; a transfer token goes only to the Admin's own origin). */
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
  | "invalid_job" | "unknown_job" | "invalid_args" | "busy" | "interrupted" | "audit_unavailable" | "refused_by_policy" | "image_refused"
  | "no_home" | "docker" | "pull_failed" | "unhealthy" | "update_rolled_back" | "rollback_failed"
  | "not_found" | "disk_full" | "port_in_use" | "box_unavailable" | "transfer_failed" | "self_update_failed"
  | "unsigned_job" | "wrong_box" | "expired_job" | "pending_box"
  /** A customer-run server only: the job is not on its list, its admin has paused remote management, or its own updater is missing or declined, or the image asked for is older than the one running. */
  | "refused_by_mode" | "paused" | "update_unavailable" | "update_not_started" | "older_version";

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

/** `POST {admin}{ENROLL_PATH}` body. `publicKey`: the box key's raw 32 bytes, base64url. */
export interface EnrollRequest {
  code: string;
  publicKey: string;
  host: HostFacts;
  connector: ConnectorIdentity;
  /**
   * Sent only by a customer-run server, so an `operated` enrolment is the same request as before this field existed.
   * The Admin keeps it with the box: such a box refuses `export-disk`, `import-disk`, a `start` that carries an image
   * or settings, every request to the home outside its list, and reports only the reduced heartbeat.
   */
  mode?: "customer-run";
}

/**
 * A box the team's Owner has not accepted yet is `pending`: it connects and reports its health, and the Admin sends it no
 * job that carries the team's data or changes anything. `revoked` is never sent: a revoked key is refused (4401).
 */
export type BoxState = "pending" | "accepted";

export interface EnrollResponse {
  boxId: string;
  teamId: string;
  /** The Admin's signing keys by id, raw Ed25519 public keys in base64url; the connector pins them. One or two (rotation). */
  adminKeys: Record<string, string>;
  state: BoxState;
}

/** Admin → connector, the first message on every connection. `nonce`: 32 random bytes, base64url. */
export interface Challenge {
  t: "challenge";
  v: 1;
  nonce: string;
}

/** Connector → Admin: `sig` is the box key's signature of `authText(box, challenge nonce, nonce, count)`. */
export interface Auth {
  t: "auth";
  v: 1;
  box: string;
  count: number;
  nonce: string;
  sig: string;
}

export function authText(box: string, adminNonce: string, boxNonce: string, count: number): string {
  return `omb-box auth v1\n${box}\n${adminNonce}\n${boxNonce}\n${count}`;
}

/** Admin → connector, `{t: "hello", signed}`: an envelope (signed.ts) of this payload, under a key the connector pinned. */
export interface HelloPayload {
  t: "hello";
  kid: string;
  box: string;
  adminNonce: string;
  boxNonce: string;
  count: number;
  /** The Admin's clock (ms); the connector judges a job's age by it, whatever its own clock says. */
  now: number;
  state: BoxState;
  /** The Admin's signing keys from now on (rotation); absent: unchanged. */
  keys?: Record<string, string>;
}

/** Admin → connector, `{job: envelope}`. Only for this box, only while `exp` (the Admin's clock) has not passed. */
export interface JobPayload {
  t: "job";
  kid: string;
  box: string;
  iat: number;
  exp: number;
  job: Job;
}

/** The update window, in the server's time zone (`days`: 0 is Sunday; `end` before `start` runs past midnight). */
export interface UpdateWindow {
  days: number[];
  start: string;
  end: string;
  timeZone: string;
}

/**
 * Admin → connector, `{config: envelope}`, after each hello and on each change; a higher `version` replaces a lower one.
 * The connector keeps the newest it verified on its disk and goes by it while the Admin can't be reached.
 */
export interface ConfigPayload {
  t: "config";
  kid: string;
  box: string;
  iat: number;
  version: number;
  state: BoxState;
  schedule: {
    window: UpdateWindow | null;
    ring: "early" | "standard" | "late";
    /** Updates wait until then (ms). */
    holdUntil: number | null;
    /** The home image this server should run. */
    image: string | null;
  };
  policy: {
    /** How long members' sessions last past the Admin's last check while it can't be reached. */
    offlineHours: number;
  };
}

/** Admin → connector before it restarts: reconnect after `reconnectInMs` plus a random part of `tryForMs`. */
export interface Restarting {
  t: "restarting";
  reconnectInMs: number;
  tryForMs: number;
}

/** What the box signs for `Authorization: Box <envelope>` on a transfer; `kid` is "box". */
export interface TransferPayload {
  t: "transfer";
  kid: "box";
  box: string;
  job: string;
  iat: number;
  exp: number;
}

// Validation, shared so both sides refuse the same things.

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENV_NAME = /^OMB_[A-Z0-9_]{1,60}$/;
// oxlint-disable-next-line no-control-regex
const ENV_VALUE = /^[^\0\r\n]{0,8192}$/;
const MAX_ENV = 64;

/** The home's boot contract: without these the home refuses to start. */
export const REQUIRED_HOME_ENV = ["OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_PUBLIC_URL", "OMB_CLOUD_BOOTSTRAP_SECRET"] as const;

/** Settings the image owns, or that make sense only on Fly; a home on an own server never takes them from outside. */
export const REFUSED_HOME_ENV = new Set([
  "OMB_CLOUD_EDGE_HOLD", "OMB_CLOUD_EDGE_BIN", "OMB_CLOUD_EDGE_CONFIG", "OMB_CLOUD_HARDEN",
  "OMB_DATA_DIR", "OMB_STATIC_DIR", "OMB_DUCKDB_DIR", "OMB_PORT", "OMB_WEBHOOK_PORT", "OMB_CLOUD_SECRETS_FD", "OMB_CLOUD_CAPS_DROPPED", "OMB_CLOUD_TUNNEL_BIN",
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

const B64U_KEY = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[a-z0-9]{1,16}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const BOX_ID = /^[A-Za-z0-9_-]{8,64}$/;
const isBoxState = (value: unknown): value is BoxState => value === "pending" || value === "accepted";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const checkBoxId = (value: unknown): value is string => typeof value === "string" && BOX_ID.test(value);
export const checkNonce = (value: unknown): value is string => typeof value === "string" && NONCE.test(value);

/** One or two signing keys by id, each a raw Ed25519 public key in base64url. */
export function checkKeys(value: unknown): Checked<Record<string, string>> {
  if (!plainObject(value)) return { ok: false, message: "keys must be an object" };
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 2) return { ok: false, message: "one or two keys" };
  for (const [kid, key] of entries) if (!KEY_ID.test(kid) || typeof key !== "string" || !B64U_KEY.test(key)) return { ok: false, message: "a key is malformed" };
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

export function checkEnrollResponse(value: unknown): Checked<EnrollResponse> {
  if (!plainObject(value)) return { ok: false, message: "the enrolment answer is not a JSON object" };
  const { boxId, teamId, adminKeys, state } = value;
  if (!checkBoxId(boxId)) return { ok: false, message: "the enrolment answer has no valid boxId" };
  if (typeof teamId !== "string" || !OPAQUE_ID.test(teamId)) return { ok: false, message: "the enrolment answer has no valid teamId" };
  const keys = checkKeys(adminKeys);
  if (!keys.ok) return { ok: false, message: `the enrolment answer's adminKeys: ${keys.message}` };
  if (!isBoxState(state)) return { ok: false, message: "the enrolment answer has no valid state" };
  return { ok: true, value: { boxId, teamId, adminKeys: keys.value, state } };
}

/** A verified hello's payload for this connection: this box, both nonces, this count. */
export function checkHello(payload: Record<string, unknown>, expected: { box: string; adminNonce: string; boxNonce: string; count: number }): Checked<HelloPayload> {
  if (payload.t !== "hello") return { ok: false, message: "not a hello" };
  if (payload.box !== expected.box) return { ok: false, message: "the hello is for another box" };
  if (payload.adminNonce !== expected.adminNonce || payload.boxNonce !== expected.boxNonce || payload.count !== expected.count) return { ok: false, message: "the hello is not for this connection" };
  if (!isTime(payload.now) || !isBoxState(payload.state)) return { ok: false, message: "the hello is malformed" };
  if (payload.keys !== undefined && !checkKeys(payload.keys).ok) return { ok: false, message: "the hello's keys are malformed" };
  return { ok: true, value: payload as unknown as HelloPayload };
}

/** A verified job envelope's payload: for `box`, signed at most `JOB_LIFETIME_MS` ago by the Admin's clock (`adminNow`). */
export function checkJobPayload(payload: Record<string, unknown>, box: string, adminNow: number): { ok: true; job: unknown } | { ok: false; code: "wrong_box" | "expired_job" | "unsigned_job"; message: string } {
  if (payload.t !== "job" || !isTime(payload.iat) || !isTime(payload.exp)) return { ok: false, code: "unsigned_job", message: "not a signed job" };
  if (payload.box !== box) return { ok: false, code: "wrong_box", message: "the job was signed for another server" };
  if (payload.exp - payload.iat > JOB_LIFETIME_MS || adminNow > payload.exp || adminNow < payload.iat - JOB_LIFETIME_MS) {
    return { ok: false, code: "expired_job", message: "the job's signature is too old" };
  }
  return { ok: true, job: payload.job };
}

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;

/** A verified config envelope's payload for `box`. */
export function checkConfig(payload: Record<string, unknown>, box: string): Checked<ConfigPayload> {
  if (payload.t !== "config" || payload.box !== box) return { ok: false, message: "the config is for another box" };
  if (!isTime(payload.iat) || typeof payload.version !== "number" || !Number.isSafeInteger(payload.version) || payload.version < 1 || !isBoxState(payload.state)) {
    return { ok: false, message: "the config is malformed" };
  }
  const schedule = payload.schedule, policy = payload.policy;
  if (!plainObject(schedule) || !plainObject(policy)) return { ok: false, message: "the config is malformed" };
  const window = schedule.window;
  if (window !== null && (!plainObject(window) || !Array.isArray(window.days) || window.days.length > 7
    || window.days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
    || typeof window.start !== "string" || !CLOCK.test(window.start) || typeof window.end !== "string" || !CLOCK.test(window.end)
    || typeof window.timeZone !== "string" || !TIME_ZONE.test(window.timeZone))) return { ok: false, message: "the update window is malformed" };
  if (!["early", "standard", "late"].includes(schedule.ring as string)) return { ok: false, message: "the ring is malformed" };
  if (schedule.holdUntil !== null && !isTime(schedule.holdUntil)) return { ok: false, message: "the hold is malformed" };
  if (schedule.image !== null && (typeof schedule.image !== "string" || !HOME_IMAGE.test(schedule.image))) return { ok: false, message: "the image is malformed" };
  if (typeof policy.offlineHours !== "number" || !Number.isInteger(policy.offlineHours) || policy.offlineHours < 0 || policy.offlineHours > 720) return { ok: false, message: "the policy is malformed" };
  return { ok: true, value: payload as unknown as ConfigPayload };
}

/** A one-time code as the Admin shows it: letters, digits and dashes. */
export function checkEnrollCode(value: unknown): Checked<string> {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/.test(value)
    ? { ok: true, value }
    : { ok: false, message: "the code is the one-time code MausBot shows next to the install command" };
}
