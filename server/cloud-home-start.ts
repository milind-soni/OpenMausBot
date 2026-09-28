// Entry point of the OMB Cloud Pro home image (deploy/fly/Dockerfile).
//
// Starts as root only to hand a fresh Fly volume (mounted root-owned at
// /data) to the unprivileged `maus` user, then drops privileges for good
// and runs two children: the OpenMausBot server on 127.0.0.1:8799 (and its
// webhook receiver on :8800) and the Caddy edge on 0.0.0.0:8080. The edge is
// the only listener the network can reach, and it always forwards with
// X-Forwarded-*, so request-auth.ts never grants a remote request loopback
// trust. If either child exits, both stop and the machine restarts.
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cloudHomeConfiguration, cloudHomeHost, prepareCloudHomeVolume, withoutIgnoredCloudKeys, type CloudHomeConfig } from "./cloud-home.ts";

const SERVICE_USER = "maus";

/** uid/gid from /etc/passwd; Node has no getpwnam. */
export function passwdIds(passwd: string, name: string): { uid: number; gid: number } | null {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "")) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

/** The server child's environment: the operator's contract plus fixed
 * ports and paths (Linux paths inside the image, so POSIX joins on every
 * host that builds them, tests included), never a platform gateway's settings. The edge child gets
 * only what it needs to route. */
export function cloudHomeChildEnvironments(config: CloudHomeConfig, env: NodeJS.ProcessEnv, home: string) {
  const server: NodeJS.ProcessEnv = {
    ...withoutIgnoredCloudKeys(env), HOME: home, OMB_DATA_DIR: env.OMB_DATA_DIR || posix.join(home, ".openmausbot"),
    OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800", OMB_PUBLIC_URL: config.publicOrigin,
    OMB_WEBHOOK_PUBLIC_URL: env.OMB_WEBHOOK_PUBLIC_URL || config.publicOrigin,
  };
  const edge: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/omb-edge",
    XDG_DATA_HOME: "/tmp/omb-edge/data", XDG_CONFIG_HOME: "/tmp/omb-edge/config",
    OMB_CLOUD_PUBLIC_HOST: cloudHomeHost(config),
  };
  return { server, edge };
}

export function startCloudHome(env: NodeJS.ProcessEnv = process.env) {
  process.umask(0o077);
  const config = cloudHomeConfiguration(env);
  if (!config) throw new Error("This image runs an OMB Cloud home machine; set its boot contract (docs/cloud-pro.md).");
  // Logged here once: the server child never sees what they are about.
  for (const warning of config.warnings) console.warn(`cloud home: ${warning}`);
  const home = env.HOME || "/data";
  if (process.getuid?.() === 0) {
    const ids = passwdIds(readFileSync("/etc/passwd", "utf8"), SERVICE_USER);
    if (!ids) throw new Error(`The ${SERVICE_USER} user is missing from this image.`);
    // A new volume is a root-owned mount point. Only the mount point itself
    // changes owner; anything inside keeps the owner it already has.
    const stat = statSync(home);
    if (stat.uid !== ids.uid || stat.gid !== ids.gid) chownSync(home, ids.uid, ids.gid);
    process.setgroups?.([]);
    process.setgid!(ids.gid);
    process.setuid!(ids.uid);
  }
  if (process.getuid?.() === 0) throw new Error("The Cloud home must run as an unprivileged user.");
  prepareCloudHomeVolume(home, config.machineId);
  const here = dirname(fileURLToPath(import.meta.url));
  const { server, edge } = cloudHomeChildEnvironments(config, env, home);
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
  const run = (command: string, args: string[], childEnv: NodeJS.ProcessEnv) => {
    const child = spawn(command, args, { env: childEnv, stdio: "inherit" });
    children.push(child);
    child.once("error", () => stop(true));
    child.once("exit", () => stop(true));
  };
  run(process.execPath, [join(here, "index.js")], server);
  run(env.OMB_CLOUD_EDGE_BIN || "/usr/local/bin/caddy", ["run", "--config", env.OMB_CLOUD_EDGE_CONFIG || "/app/cloud/Caddyfile", "--adapter", "caddyfile"], edge);
  process.once("SIGTERM", () => stop(false));
  process.once("SIGINT", () => stop(false));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startCloudHome(); } catch (error) {
    console.error(`Cloud home startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
