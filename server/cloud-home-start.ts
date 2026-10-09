// Entry point of the OMB Cloud Pro home image (the Dockerfile's cloud-home target).
//
// Starts as root, hands a fresh Fly volume (mounted root-owned at /data) to
// the unprivileged `maus` user, and stays a small root supervisor of two
// children that run as `maus`: the OpenMausBot server on 127.0.0.1:8799
// (and its webhook receiver on :8800) and the Caddy edge on 0.0.0.0:8080.
// The edge is the only listener the network can reach, and it always
// forwards with X-Forwarded-*, so request-auth.ts never grants a remote
// request loopback trust. If either child exits, both stop and the machine
// restarts; the one exception is the server asking to be started again
// after a restore (server/restart.ts).
//
// The machine's secrets (the signing secret, the relay tokens) arrive as
// this process's environment. No child's environment ever carries them:
// /proc/<pid>/environ keeps a process's starting environment, readable by
// anything running as the same user (an engine's shell). The server gets
// them over an inherited pipe it reads first thing and closes
// (cloud-secrets.ts), and an environment built from an allow-list, so a
// secret the platform adds later never reaches it either. This process stays
// root, so its own environment and memory are out of `maus`'s reach, and it
// runs and trusts only code `maus` cannot change: the image's, never the
// volume's (codeTrustProblem).
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLOUD_SECRETS_FD_ENV, cloudHomeConfiguration, cloudHomeHost, cloudHomeSecrets, prepareCloudHomeVolume,
  withoutCloudSecrets, withoutIgnoredCloudKeys, type CloudHomeConfig,
} from "./cloud-home.ts";
import { restartPolicy } from "./restart.ts";

const SERVICE_USER = "maus";
/** The descriptor the server reads its secrets from. */
const SECRETS_FD = 3;

/** uid/gid from /etc/passwd; Node has no getpwnam. */
export function passwdIds(passwd: string, name: string): { uid: number; gid: number } | null {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "")) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

/** What the server child may be given from this process's environment, by
 * name: the process basics, what the image sets, and the Cloud home's
 * contract that is not secret. Anything else (a secret the platform adds
 * later, a test's key, a platform gateway's settings) is left out. */
const SERVER_ENV_NAMES = new Set([
  "PATH", "SHELL", "HOSTNAME", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "NO_COLOR", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "AGENT_BROWSER_EXECUTABLE_PATH", "OMB_STATIC_DIR", "OMB_DATA_DIR",
  "OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_CLOUD_IMAGE", "OMB_PUBLIC_URL", "OMB_WEBHOOK_PUBLIC_URL",
  "OMB_CLOUD_BOAT_URL", "OMB_CLOUD_VOICE_URL", "OMB_CLOUD_DECIDER_URL", "OMB_CLOUD_X_URL", "OMB_TTS_DEFAULT_VOICE",
]);
export function serverEnvironmentAllowed(name: string): boolean {
  return SERVER_ENV_NAMES.has(name) || name.startsWith("LC_");
}

/** The server child's environment: the allowed part of the operator's
 * contract (serverEnvironmentAllowed) plus fixed ports and paths (Linux
 * paths inside the image, so POSIX joins on every host that builds them,
 * tests included), never a platform gateway's settings and never a secret
 * (`secrets`, handed over the pipe instead). `dropped` names what was left
 * out, for the log. The edge child gets only what it needs to route. */
export function cloudHomeChildEnvironments(config: CloudHomeConfig, env: NodeJS.ProcessEnv, home: string) {
  const offered = withoutCloudSecrets(withoutIgnoredCloudKeys(env));
  const allowed = Object.fromEntries(Object.entries(offered).filter(([name, value]) => value !== undefined && serverEnvironmentAllowed(name)));
  const dropped = Object.keys(offered).filter((name) => !serverEnvironmentAllowed(name) && name !== "HOME").sort();
  const server: NodeJS.ProcessEnv = {
    ...allowed, HOME: home, OMB_DATA_DIR: env.OMB_DATA_DIR || posix.join(home, ".openmausbot"),
    OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800", OMB_PUBLIC_URL: config.publicOrigin,
    OMB_WEBHOOK_PUBLIC_URL: env.OMB_WEBHOOK_PUBLIC_URL || config.publicOrigin,
    [CLOUD_SECRETS_FD_ENV]: String(SECRETS_FD),
  };
  const edge: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/omb-edge",
    XDG_DATA_HOME: "/tmp/omb-edge/data", XDG_CONFIG_HOME: "/tmp/omb-edge/config",
    OMB_CLOUD_PUBLIC_HOST: cloudHomeHost(config),
  };
  return { server, edge, secrets: cloudHomeSecrets(env), dropped };
}

/** Why the root supervisor must not run or trust `files`, or null: each
 * must be root's and not writable by anyone else (nor any folder above it),
 * and none may live on the volume `home`, which `maus` owns. The image makes its code
 * root's (the Dockerfile's cloud-home target); a file `maus` could rewrite would run as
 * root at the next start, or be handed the secrets. */
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

/** Start the server with its secrets on an inherited pipe (never its
 * environment), as `ids` when given. The pipe is written and closed at once;
 * nothing else is ever sent on it. With `capture`, its stdout and stderr are
 * pipes the caller reads instead of this process's inherited descriptors. */
export function spawnWithSecrets(command: string, args: string[], env: NodeJS.ProcessEnv, secrets: Record<string, string>,
  ids?: { uid: number; gid: number } | null, capture = false): ChildProcess {
  const child = spawn(command, args, { env,
    stdio: capture ? ["inherit", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit", "pipe"],
    ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) });
  const pipe = child.stdio[SECRETS_FD] as NodeJS.WritableStream | null;
  pipe?.on("error", () => { /* the child is gone; its exit is handled by the caller */ });
  pipe?.end(JSON.stringify(secrets));
  return child;
}

export function startCloudHome(env: NodeJS.ProcessEnv = process.env) {
  process.umask(0o077);
  const config = cloudHomeConfiguration(env);
  if (!config) throw new Error("This image runs a My Cloud machine for OpenMausBot Cloud; set its boot contract (docs/cloud-pro.md).");
  // Logged here once: the server child never sees what they are about.
  for (const warning of config.warnings) console.warn(`cloud home: ${warning}`);
  const home = env.HOME || "/data";
  // Who the children run as: `maus` when this starts as root (the image),
  // else whoever started it (a test, a dev machine).
  let ids: { uid: number; gid: number } | null = null;
  if (process.getuid?.() === 0) {
    ids = passwdIds(readFileSync("/etc/passwd", "utf8"), SERVICE_USER);
    if (!ids) throw new Error(`The ${SERVICE_USER} user is missing from this image.`);
    // A new volume is a root-owned mount point. Only the mount point itself
    // changes owner; anything inside keeps the owner it already has.
    const stat = statSync(home);
    if (stat.uid !== ids.uid || stat.gid !== ids.gid) chownSync(home, ids.uid, ids.gid);
    process.setgroups?.([]);
    // The volume is prepared as `maus`, so what it creates is theirs.
    process.setegid!(ids.gid);
    process.seteuid!(ids.uid);
    try { prepareCloudHomeVolume(home, config.machineId); } finally {
      process.seteuid!(0);
      process.setegid!(0);
    }
  } else {
    prepareCloudHomeVolume(home, config.machineId);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const edgeBin = env.OMB_CLOUD_EDGE_BIN || "/usr/local/bin/caddy";
  const edgeConfig = env.OMB_CLOUD_EDGE_CONFIG || "/app/cloud/Caddyfile";
  if (ids) {
    const problem = codeTrustProblem([process.execPath, fileURLToPath(import.meta.url), join(here, "index.js"), edgeBin, edgeConfig], home);
    if (problem) throw new Error(`This image's code is not safe to run as root: ${problem}. Rebuild it with docker build --target cloud-home.`);
  }
  const { server, edge, secrets, dropped } = cloudHomeChildEnvironments(config, env, home);
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
    watch(spawnWithSecrets(process.execPath, [join(here, "index.js")], server, secrets, ids), (code) => {
      if (!policy.again(code, stopping)) return false;
      runServer();
      return true;
    });
  };
  runServer();
  watch(spawn(edgeBin, ["run", "--config", edgeConfig, "--adapter", "caddyfile"],
    { env: edge, stdio: "inherit", ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) }));
  process.once("SIGTERM", () => stop(false));
  process.once("SIGINT", () => stop(false));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startCloudHome(); } catch (error) {
    console.error(`Cloud home startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
