// The Cloud home image's entry point: a root supervisor of two `maus` children, the server on 127.0.0.1:8799 and the Caddy
// edge on 0.0.0.0:8080, the only listener the network reaches, always forwarding X-Forwarded-*, so no remote request gets
// loopback trust. Secrets never ride a child's environment (/proc/<pid>/environ stays readable by the same user): the
// server reads them from an inherited pipe. Root runs and trusts only the image's code, never the volume's.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLOUD_HOME_SECRET_KEYS, CLOUD_SECRETS_FD_ENV, cloudHomeConfiguration, cloudHomeHost, cloudHomeSecrets, prepareCloudHomeVolume,
  withoutCloudSecrets, withoutIgnoredCloudKeys, type CloudHomeConfig,
} from "./cloud-home.ts";
import { procHidepid } from "./bot-box/hidepid.ts";
import { boxMemory, heapSizeArgs } from "./box-memory.ts";
import { clearRecordsFromOtherMachines } from "./data-dir-lease.ts";
import { OOM_SCORE, protectSupervisor, spawnWithOomScore } from "./oom-score.ts";
import { restartPolicy } from "./restart.ts";

const SERVICE_USER = "maus";
const SECRETS_FD = 3;

/** uid/gid from /etc/passwd; Node has no getpwnam. */
export function passwdIds(passwd: string, name: string): { uid: number; gid: number } | null {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "")) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

/** An allow-list by name, so a secret the platform adds later never reaches the server. Every setting the image's ENV
 * gives the server belongs here too (docker-image.test.ts checks): without OMB_DUCKDB_DIR the server found neither the
 * 1Password SDK nor DuckDB, which the image keeps in /app/duckdb, and said 1Password was "not available in this build". */
const SERVER_ENV_NAMES = new Set([
  "PATH", "SHELL", "HOSTNAME", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "NO_COLOR", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "AGENT_BROWSER_EXECUTABLE_PATH", "OMB_STATIC_DIR", "OMB_DATA_DIR", "OMB_DUCKDB_DIR",
  "OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_CLOUD_IMAGE", "OMB_PUBLIC_URL", "OMB_WEBHOOK_PUBLIC_URL",
  "OMB_CLOUD_TEAM_ID", "OMB_CLOUD_TEAM_NAME", "OMB_CLOUD_BOAT_URL", "OMB_CLOUD_VOICE_URL", "OMB_CLOUD_DECIDER_URL", "OMB_CLOUD_AI_URL", "OMB_CLOUD_X_URL", "OMB_TTS_DEFAULT_VOICE",
  "OMB_COMPOSIO_BROKER_URL",
  // The bot box switch (server/bot-box/detect.ts): the Admin may turn a home's box off for support.
  "OMB_BOT_BOX",
  // An ended Cloud started only for its owner's export: the server runs frozen (server/move-freeze.ts).
  "OMB_CLOUD_EXPORT_ONLY",
]);
export function serverEnvironmentAllowed(name: string): boolean {
  return SERVER_ENV_NAMES.has(name) || name.startsWith("LC_");
}

/** Caddy duration for OMB_CLOUD_EDGE_HOLD: whole seconds, at most 120; anything else is no hold (0s). */
export function edgeHold(raw: string | undefined): string {
  const match = /^(\d{1,3})s$/.exec(raw?.trim() ?? "");
  return match && Number(match[1]) <= 120 ? `${Number(match[1])}s` : "0s";
}

/** How a home on its owner's server is reached (docs/cloud-pro.md, "On your own server"); never set on Fly. */
export const OWN_SERVER_EDGE_KEYS = ["OMB_CLOUD_EDGE_TLS", "OMB_CLOUD_TRUSTED_PROXIES", "OMB_CLOUD_CLIENT_IP_HEADER", "OMB_CLOUD_TUNNEL_TOKEN"] as const;
const EDGE_CONFIG_DIR = "/app/cloud";
export const EDGE_ROUTES_FILE = "edge-routes.caddy";
const MAX_TRUSTED_PROXIES = 32;

function invalidEdge(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

const onFly = (env: NodeJS.ProcessEnv) => Boolean(env.FLY_APP_NAME?.trim());

/** OMB_CLOUD_EDGE_TLS=1: the edge gets and renews the certificate for OMB_PUBLIC_URL's name and serves it on 443. */
export function edgeTerminatesTls(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OMB_CLOUD_EDGE_TLS?.trim() ?? "";
  if (raw !== "" && raw !== "0" && raw !== "1") invalidEdge("OMB_CLOUD_EDGE_TLS must be 1 (the home serves HTTPS on its own domain) or 0");
  return raw === "1";
}

/**
 * OMB_CLOUD_TUNNEL_TOKEN: the connector token of this home's Cloudflare tunnel, for a server with no inbound port. The
 * home runs cloudflared itself and OMB_PUBLIC_URL is the tunnel's address. Only cloudflared ever reads the token.
 */
export function edgeTunnelToken(env: NodeJS.ProcessEnv): string | null {
  const token = env.OMB_CLOUD_TUNNEL_TOKEN?.trim() ?? "";
  if (!token) return null;
  if (!/^[A-Za-z0-9+/_=-]{32,4096}$/.test(token)) invalidEdge("OMB_CLOUD_TUNNEL_TOKEN must be the tunnel's connector token");
  if (edgeTerminatesTls(env)) invalidEdge("OMB_CLOUD_EDGE_TLS and OMB_CLOUD_TUNNEL_TOKEN are two ways to reach the home; set one");
  return token;
}

/**
 * The proxies an owner puts in front of the home, from OMB_CLOUD_TRUSTED_PROXIES: addresses, CIDR ranges or Caddy's
 * `private_ranges`, separated by spaces or commas. Each is written into the edge's config as a token, so anything else is
 * refused; so is a /0 range, which would let any client name itself and step round the pairing lockout.
 */
export function trustedProxyList(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (entries.length > MAX_TRUSTED_PROXIES) invalidEdge(`OMB_CLOUD_TRUSTED_PROXIES names more than ${MAX_TRUSTED_PROXIES} proxies`);
  return entries.map((entry) => {
    if (entry === "private_ranges") return entry;
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address ?? "");
    const bits = family === 4 ? 32 : 128;
    const width = prefix === undefined ? bits : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!family || extra !== undefined || !(width >= 1 && width <= bits)) {
      invalidEdge(`OMB_CLOUD_TRUSTED_PROXIES must list proxy addresses or ranges such as 10.0.0.5 or 10.0.0.0/24 ("${entry.slice(0, 64)}" is not one, and /0 is refused)`);
    }
    return `${address}/${width}`;
  });
}

/**
 * Who may name the client to the edge, and in which header (deploy/fly/Caddyfile). On Fly only Fly's proxy reaches the
 * edge, from its private ranges, and it overwrites Fly-Client-IP. On an own server nobody may: the client is the TCP
 * peer, so a header from a stranger, a local process or a bot is ignored. Only the proxies its owner names in
 * OMB_CLOUD_TRUSTED_PROXIES may, in OMB_CLOUD_CLIENT_IP_HEADER (X-Forwarded-For unless set). The address feeds the
 * pairing lockout, never authorization.
 */
export function edgeClientAddress(env: NodeJS.ProcessEnv): { OMB_CLOUD_EDGE_CLIENT_IP_HEADER: string; OMB_CLOUD_EDGE_TRUSTED_PROXIES: string } {
  if (onFly(env)) {
    const set = OWN_SERVER_EDGE_KEYS.filter((key) => env[key]?.trim());
    if (set.length) invalidEdge(`${set.join(", ")} ${set.length === 1 ? "is" : "are"} for a home on its own server; on Fly, Fly's proxy ends TLS and names the client`);
    return { OMB_CLOUD_EDGE_CLIENT_IP_HEADER: "Fly-Client-IP", OMB_CLOUD_EDGE_TRUSTED_PROXIES: "private_ranges" };
  }
  const proxies = trustedProxyList(env.OMB_CLOUD_TRUSTED_PROXIES);
  const header = env.OMB_CLOUD_CLIENT_IP_HEADER?.trim() ?? "";
  if (header && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(header)) invalidEdge("OMB_CLOUD_CLIENT_IP_HEADER must be one header name, such as X-Forwarded-For");
  if (header && !proxies.length) invalidEdge("OMB_CLOUD_CLIENT_IP_HEADER needs OMB_CLOUD_TRUSTED_PROXIES: the proxies allowed to send it");
  return { OMB_CLOUD_EDGE_CLIENT_IP_HEADER: header || "X-Forwarded-For", OMB_CLOUD_EDGE_TRUSTED_PROXIES: proxies.join(" ") };
}

/** The edge's config, and the file every config imports: both run as root's trusted code. */
export function edgeConfigFiles(env: NodeJS.ProcessEnv): { config: string; routes: string } {
  const name = edgeTunnelToken(env) ? "Caddyfile.tunnel" : edgeTerminatesTls(env) ? "Caddyfile.tls" : "Caddyfile";
  const config = env.OMB_CLOUD_EDGE_CONFIG || posix.join(EDGE_CONFIG_DIR, name);
  return { config, routes: posix.join(posix.dirname(config), EDGE_ROUTES_FILE) };
}

/** Where the edge keeps its certificate and ACME account: on the volume, never /tmp, so a new container reuses them. */
export function edgeCertificateStorage(home: string): string {
  return posix.join(home, ".omb-edge", "caddy");
}

export function tunnelRestartDelay(previousMs: number, ranForMs: number): number {
  if (ranForMs >= 10 * 60_000 || previousMs <= 0) return 5_000;
  return Math.min(previousMs * 2, 5 * 60_000);
}

/** The user cloudflared runs as. Its token rides its environment (TUNNEL_TOKEN), which only that user and root can read:
 * never `maus`, whose bots could otherwise copy it and serve the home's address elsewhere. cloudflared 2026.10 can't
 * read --token-file from an inherited socket, which is all Node's stdio gives a child. */
export const TUNNEL_USER = "omb-tunnel";

export function tunnelCommand(bin: string, token: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: bin,
    args: ["tunnel", "--no-autoupdate", "--loglevel", "info", "run"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", TUNNEL_TOKEN: token },
  };
}

/** The server's data directory on the volume. */
export function cloudHomeDataDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.OMB_DATA_DIR || posix.join(home, ".openmausbot");
}

/** flock(1)'s exit status when another process holds the lock (its --conflict-exit-code). */
const VOLUME_HELD = 75;
const heldVolumes = new Set<string>();

type VolumeLock = (fd: number) => { status: number | null; error?: Error; stderr?: string };

const flockVolume: VolumeLock = (fd) => spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", String(VOLUME_HELD), "3"],
  { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", timeout: 10_000 });

/**
 * Locks the volume for as long as this process lives, or refuses: a second home on the same volume must never start.
 * Docker lets any number of containers mount one volume, each in its own pid namespace, so no pid or lease record can
 * tell a live home from a dead one; a kernel lock on the volume can, and the kernel drops it when this process dies.
 * The lock is flock(2) on the volume's root, an inode `maus` cannot replace. flock(1) takes it on this process's own
 * open descriptor, which keeps it after flock exits.
 */
export function holdVolume(home: string, lock: VolumeLock = flockVolume): void {
  const root = realpathSync(home);
  if (heldVolumes.has(root)) return;
  const fd = openSync(root, "r");
  const result = lock(fd);
  if (result.status === 0) {
    heldVolumes.add(root);
    return;
  }
  closeSync(fd);
  if (result.status === VOLUME_HELD) throw new Error("Another MausBot home is already running on this volume. No data was changed.");
  const why = result.error?.message ?? (String(result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}`);
  throw new Error(`This home could not lock its volume (${why}), so it will not start: another home might be using it. No data was changed.`);
}

/**
 * Locks the volume (`holdVolume`), confirms it is this Cloud's (`prepareCloudHomeVolume`), then clears the data-directory
 * records another machine or container left on it. With the volume locked no other home is running on it, and every
 * home the Admin makes on a kept volume (a resume, a restore, an export; a new container on an own server) is another
 * machine or container, so its records are always stale here: one a home destroyed mid-boot left (seen live Oct 23
 * 2026) made every later home exit at once refusing it. A lease from this one is the server's own to refuse or recover.
 * Returns what was cleared, for the log.
 */
export function prepareCloudHomeData(home: string, dataDir: string, machineId: string, lock: (home: string) => void = holdVolume) {
  lock(home);
  const volume = prepareCloudHomeVolume(home, machineId);
  return { volume, cleared: clearRecordsFromOtherMachines(dataDir) };
}

export function cloudHomeChildEnvironments(config: CloudHomeConfig, env: NodeJS.ProcessEnv, home: string) {
  const offered = withoutCloudSecrets(withoutIgnoredCloudKeys(env));
  const allowed = Object.fromEntries(Object.entries(offered).filter(([name, value]) => value !== undefined && serverEnvironmentAllowed(name)));
  const dropped = Object.keys(offered).filter((name) => !serverEnvironmentAllowed(name) && name !== "HOME" && name !== CAPS_DROPPED_ENV).sort();
  const dataDir = cloudHomeDataDir(env, home);
  const server: NodeJS.ProcessEnv = {
    ...allowed, HOME: home, OMB_DATA_DIR: dataDir,
    // Node keys the entries by its own version and the file's hash, so a stale entry is never used after an image upgrade.
    NODE_COMPILE_CACHE: posix.join(dataDir, "cache", "node-compile"),
    OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800", OMB_PUBLIC_URL: config.publicOrigin,
    OMB_WEBHOOK_PUBLIC_URL: env.OMB_WEBHOOK_PUBLIC_URL || config.publicOrigin,
    [CLOUD_SECRETS_FD_ENV]: String(SECRETS_FD),
  };
  const edge: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/omb-edge",
    XDG_DATA_HOME: "/tmp/omb-edge/data", XDG_CONFIG_HOME: "/tmp/omb-edge/config",
    OMB_CLOUD_PUBLIC_HOST: cloudHomeHost(config),
    // A plan whose home sleeps: requests wait this long for the server while it starts (deploy/fly/Caddyfile). Unset: 0s.
    OMB_CLOUD_EDGE_HOLD: edgeHold(env.OMB_CLOUD_EDGE_HOLD),
    ...edgeClientAddress(env),
    ...(edgeTerminatesTls(env) ? { OMB_CLOUD_EDGE_STORAGE: edgeCertificateStorage(home) } : {}),
  };
  return { server, edge, edgeFiles: edgeConfigFiles(env), tunnelToken: edgeTunnelToken(env), secrets: cloudHomeSecrets(env), dropped };
}

/** Set in the supervisor's own environment once it has started again without CAP_SYS_ADMIN, so it never loops. */
export const CAPS_DROPPED_ENV = "OMB_CLOUD_CAPS_DROPPED";
const CAP_SYS_ADMIN = 21;
const SETPRIV = "/usr/bin/setpriv";

/** A capability's bit in one of /proc/self/status's sets (CapBnd, CapEff, CapInh). */
export function hasCapability(status: string, set: "CapBnd" | "CapEff" | "CapInh", bit: number): boolean {
  const hex = new RegExp(`^${set}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1];
  return hex ? ((BigInt(`0x${hex}`) >> BigInt(bit)) & 1n) === 1n : false;
}

export interface HostHardening {
  notes: string[];
  /** CAP_SYS_ADMIN served the remount and nothing after it: start again through setpriv without it (dropCapabilities). */
  dropCapabilities: boolean;
}

/** What root does to the machine before anything runs as `maus` (docs/bot-box.md, "What each layer stops"): /proc hides
 * other users' processes (`hidepid=invisible`), so no `maus` process lists root's, and Fly's local API socket folder is
 * root's alone. Each step is one command; a failure is logged, never fatal, and OMB_CLOUD_HARDEN=0 skips them all.
 * CAP_SYS_ADMIN, which an own server's connector grants only for the remount, must not outlive it. */
export function hardenHost(env: NodeJS.ProcessEnv, run: {
  exec: (command: string, args: string[]) => { status: number | null; stderr?: string };
  chmod: (path: string, mode: number) => void;
  exists: (path: string) => boolean;
  read: (path: string) => string;
} = {
  exec: (command, args) => spawnSync(command, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 }), chmod: chmodSync, exists: existsSync,
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
}): HostHardening {
  if (env.OMB_CLOUD_HARDEN === "0") return { notes: ["hardening skipped (OMB_CLOUD_HARDEN=0)"], dropCapabilities: false };
  const notes: string[] = [];
  if (procHidepid(() => run.read("/proc/mounts"))) notes.push("/proc: hidepid=invisible");
  else {
    const remount = run.exec("mount", ["-o", "remount,hidepid=invisible", "/proc"]);
    notes.push(remount.status === 0 ? "/proc: hidepid=invisible" : `/proc: hidepid not applied (${String(remount.stderr ?? "").trim().split("\n")[0] || `exit ${remount.status}`})`);
  }
  const status = run.read("/proc/self/status");
  const kept = hasCapability(status, "CapBnd", CAP_SYS_ADMIN) || hasCapability(status, "CapEff", CAP_SYS_ADMIN);
  if (kept && env[CAPS_DROPPED_ENV] !== "1") {
    if (run.exists(SETPRIV)) return { notes, dropCapabilities: true };
    notes.push(`CAP_SYS_ADMIN kept: ${SETPRIV} is missing`);
  } else if (kept) {
    // libcap-ng (setpriv) skips a bounding-set drop without CAP_SETPCAP and still exits 0.
    notes.push("CAP_SYS_ADMIN kept: it could not be dropped (CAP_SETPCAP is missing)");
  } else if (env[CAPS_DROPPED_ENV] === "1") {
    notes.push("CAP_SYS_ADMIN dropped");
  }
  if (run.exists("/.fly")) {
    try { run.chmod("/.fly", 0o700); notes.push("/.fly: root only"); } catch (error) { notes.push(`/.fly: left as is (${error instanceof Error ? error.message : String(error)})`); }
  }
  return { notes, dropCapabilities: false };
}

/** Starts this supervisor again in its own process, without CAP_SYS_ADMIN or CAP_SETPCAP in any set it could regain them from. */
export function setprivArgs(execPath: string, script: string): string[] {
  return ["setpriv", "--inh-caps=-sys_admin,-setpcap", "--bounding-set=-sys_admin,-setpcap", "--", execPath, script];
}

/** Replaces this process; returns only why it could not. */
function dropCapabilities(env: NodeJS.ProcessEnv): string {
  if (typeof process.execve !== "function") return "this Node cannot start itself again in place";
  try {
    process.execve(SETPRIV, setprivArgs(process.execPath, fileURLToPath(import.meta.url)), { ...env, [CAPS_DROPPED_ENV]: "1" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "setpriv did not start";
}

/** Where an own server's connector mounts the home's secrets, read-only, instead of putting them in its environment. */
export const CLOUD_SECRETS_FILE = "/run/mausbot/secrets.json";
/** What the file may hold: the server's secrets, and the tunnel's token, which only cloudflared gets. */
export const CLOUD_SECRETS_FILE_KEYS = [...CLOUD_HOME_SECRET_KEYS, "OMB_CLOUD_TUNNEL_TOKEN"] as const;

/** The secrets in CLOUD_SECRETS_FILE, when it is there: root's, readable by root alone, off the volume; known names only. */
export function readCloudSecretsFile(home: string, file = CLOUD_SECRETS_FILE, fs: {
  exists: (path: string) => boolean;
  lstat: (path: string) => Pick<Stats, "uid" | "mode" | "isFile" | "isSymbolicLink">;
  stat: (path: string) => Pick<Stats, "uid" | "mode">;
  read: (path: string) => string;
} = { exists: existsSync, lstat: lstatSync, stat: statSync, read: (path) => readFileSync(path, "utf8") }): Record<string, string> {
  if (!fs.exists(file)) return {};
  const entry = fs.lstat(file);
  const problem = !entry.isFile() || entry.isSymbolicLink() ? `${file} is not a plain file`
    : entry.mode & 0o077 ? `${file} is readable by others than root`
      : codeTrustProblem([file], home, fs.stat);
  if (problem) throw new Error(`The home's secrets file is not safe to read: ${problem}.`);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.read(file)); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`The home's secrets file ${file} is not a JSON object.`);
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(CLOUD_SECRETS_FILE_KEYS.flatMap((key) => (typeof record[key] === "string" && record[key] ? [[key, record[key] as string]] : [])));
}

/** Each file and every folder above it must be root's and not writable by others, and never on the `maus`-owned volume:
 * otherwise `maus` could rewrite what runs as root at the next start. */
export function codeTrustProblem(files: readonly string[], home: string, stat: (path: string) => Pick<Stats, "uid" | "mode"> = statSync): string | null {
  const volume = posix.join(home, "/");
  for (const file of files) {
    if (file === home || file.startsWith(volume)) return `${file} is on the volume`;
    for (let path = file; ; path = dirname(path)) {
      let owner: Pick<Stats, "uid" | "mode">;
      try { owner = stat(path); } catch { return `${path} cannot be checked`; }
      if (owner.uid !== 0) return `${path} is not root's`;
      // A folder with the sticky bit (/tmp) lets nobody replace root's files.
      if (owner.mode & 0o022 && !(path !== file && owner.mode & 0o1000)) return `${path} is writable by others than root`;
      if (dirname(path) === path) break;
    }
  }
  return null;
}

/** Secrets go over an inherited pipe, never the environment; it is written and closed at once. */
export function spawnWithSecrets(command: string, args: string[], env: NodeJS.ProcessEnv, secrets: Record<string, string>,
  ids?: { uid: number; gid: number } | null, capture = false): ChildProcess {
  const child = spawn(command, args, { env,
    stdio: capture ? ["inherit", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit", "pipe"],
    ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) });
  const pipe = child.stdio[SECRETS_FD] as NodeJS.WritableStream | null;
  pipe?.on("error", () => {});
  pipe?.end(JSON.stringify(secrets));
  return child;
}

export function startCloudHome(processEnv: NodeJS.ProcessEnv = process.env) {
  process.umask(0o077);
  const root = process.getuid?.() === 0;
  if (root && process.platform === "linux") {
    const hardening = hardenHost(processEnv);
    const notes = hardening.dropCapabilities ? [...hardening.notes, `CAP_SYS_ADMIN kept: ${dropCapabilities(processEnv)}`] : hardening.notes;
    for (const note of notes) console.log(`cloud home: ${note}`);
  }
  const home = processEnv.HOME || "/data";
  const env = root ? { ...processEnv, ...readCloudSecretsFile(home) } : processEnv;
  const config = cloudHomeConfiguration(env);
  if (!config) throw new Error("This image runs a My Cloud machine for MausBot Cloud; set its boot contract (docs/cloud-pro.md).");
  // Logged here once: the server child never sees what they are about.
  for (const warning of config.warnings) console.warn(`cloud home: ${warning}`);
  const { server, edge, edgeFiles, tunnelToken, secrets, dropped } = cloudHomeChildEnvironments(config, env, home);
  const prepare = () => prepareCloudHomeData(home, cloudHomeDataDir(env, home), config.machineId);
  let prepared: ReturnType<typeof prepare>;
  let ids: { uid: number; gid: number } | null = null;
  if (root) {
    ids = passwdIds(readFileSync("/etc/passwd", "utf8"), SERVICE_USER);
    if (!ids) throw new Error(`The ${SERVICE_USER} user is missing from this image.`);
    if (protectSupervisor()) console.log("cloud home: the supervisor is never stopped for memory");
    // Only the mount point changes owner; anything inside keeps its owner.
    const stat = statSync(home);
    if (stat.uid !== ids.uid || stat.gid !== ids.gid) chownSync(home, ids.uid, ids.gid);
    process.setgroups?.([]);
    // The volume is prepared as `maus`, so what it creates is theirs.
    process.setegid!(ids.gid);
    process.seteuid!(ids.uid);
    try { prepared = prepare(); } finally {
      process.seteuid!(0);
      process.setegid!(0);
    }
  } else {
    prepared = prepare();
  }
  for (const record of prepared.cleared) console.log(`cloud home: cleared a stale data-directory record machine ${record.host} (process ${record.pid}) left on this volume: ${record.path}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const edgeBin = env.OMB_CLOUD_EDGE_BIN || "/usr/local/bin/caddy";
  const tunnelBin = env.OMB_CLOUD_TUNNEL_BIN || "/usr/local/bin/cloudflared";
  const tunnelIds = ids && tunnelToken ? passwdIds(readFileSync("/etc/passwd", "utf8"), TUNNEL_USER) : null;
  if (ids && tunnelToken && !tunnelIds) throw new Error(`The ${TUNNEL_USER} user is missing from this image, so its tunnel cannot start.`);
  if (ids) {
    const problem = codeTrustProblem([process.execPath, fileURLToPath(import.meta.url), join(here, "index.js"), edgeBin, edgeFiles.config, edgeFiles.routes,
      ...(tunnelToken ? [tunnelBin] : [])], home);
    if (problem) throw new Error(`This image's code is not safe to run as root: ${problem}. Rebuild it with docker build --target cloud-home.`);
  }
  // Names only, never values: what the server does not get from here.
  if (dropped.length) console.log(`cloud home: not passed to the server: ${dropped.join(", ")}`);
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (failed: boolean) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = failed ? 1 : 0;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }, 20_000);
    force.unref();
  };
  const watch = (child: ChildProcess, again?: (code: number | null) => boolean) => {
    children.push(child);
    child.once("error", () => stop(true));
    child.once("exit", (code) => {
      children.splice(children.indexOf(child), 1);
      if (!again?.(code)) stop(true);
    });
  };
  const policy = restartPolicy();
  const runServer = () => {
    watch(spawnWithOomScore(OOM_SCORE.server, () => spawnWithSecrets(process.execPath, [...heapSizeArgs(boxMemory().cgroupLimit, server.NODE_OPTIONS), join(here, "index.js")], server, secrets, ids)), (code) => {
      if (!policy.again(code, stopping)) return false;
      runServer();
      return true;
    });
  };
  runServer();
  watch(spawnWithOomScore(OOM_SCORE.edge, () => spawn(edgeBin, ["run", "--config", edgeFiles.config, "--adapter", "caddyfile"],
    { env: edge, stdio: "inherit", ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) })));
  if (tunnelToken) {
    const tunnel = tunnelCommand(tunnelBin, tunnelToken);
    let delay = 0;
    const runTunnel = () => {
      if (stopping) return;
      const started = Date.now();
      const child = spawnWithOomScore(OOM_SCORE.edge, () => spawn(tunnel.command, tunnel.args,
        { env: tunnel.env, stdio: ["ignore", "inherit", "inherit"], ...(tunnelIds ? { uid: tunnelIds.uid, gid: tunnelIds.gid } : {}) }));
      children.push(child);
      const ended = (code: number | null) => {
        const index = children.indexOf(child);
        if (index < 0) return;
        children.splice(index, 1);
        if (stopping) return;
        delay = tunnelRestartDelay(delay, Date.now() - started);
        console.warn(`cloud home: the tunnel's connector stopped (${code ?? "signal"}); starting it again in ${delay / 1000} s`);
        setTimeout(runTunnel, delay).unref();
      };
      child.once("error", () => ended(null));
      child.once("exit", ended);
    };
    runTunnel();
  }
  process.once("SIGTERM", () => stop(false));
  process.once("SIGINT", () => stop(false));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startCloudHome(); } catch (error) {
    console.error(`Cloud home startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
