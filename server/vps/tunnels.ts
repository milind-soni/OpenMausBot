// Loopback SSH forwards that expose a live VPS desktop to the app viewer:
// port reservation, tunnel child lifecycle, and the join flow.

import { spawn } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";

import { DATA_DIR, isValidSshAlias, vpsSshAlias, type AppConfig } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { prepareVpsSsh } from "../vps-ssh.ts";
import { defaultRunner, snapshotVpsConfig, type VpsCommandRunner } from "./cli.ts";
import { computeVpsComputerStatus, privateDockerIpv4, viewerConnections } from "./status.ts";

const INTERNAL_VIEWER_PORT = 6901;

const desktopTunnels = new Map<
  string,
  { child: ReturnType<typeof spawn>; joinUrl: string; expiry: ReturnType<typeof setTimeout> }
>();

/** A live VPS desktop is never published by Docker. SSH binds one temporary
 * loopback port on this computer and forwards it to noVNC on the container's
 * private bridge address. Every caller-controlled component is validated
 * before it becomes an argv value. */
export function vpsSshTunnelArgs(alias: string, localPort: number, privateIp: string, configPath: string | null = null): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid VPS SSH config alias");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error("invalid VPS viewer port");
  }
  if (!privateDockerIpv4(privateIp)) throw new Error("invalid VPS private container address");
  return [
    // the app's config shares the connection every other VPS command holds,
    // so the viewer tunnel comes up without its own handshake
    ...(configPath ? ["-F", configPath] : []),
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${localPort}:${privateIp}:${INTERNAL_VIEWER_PORT}`,
    alias,
  ];
}

function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      // SAFETY: this server was bound to an IPv4 TCP address above, so Node
      // returns AddressInfo here rather than a Unix-socket string.
      const port = (probe.address() as AddressInfo).port;
      probe.close((error) => {
        if (error) reject(error);
        else if (port >= 1024) resolve(port);
        else reject(new Error("could not reserve a VPS viewer port"));
      });
    });
  });
}

function loopbackAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export function stopDesktopTunnel(botId: string): boolean {
  const tunnel = desktopTunnels.get(botId);
  if (!tunnel) return false;
  desktopTunnels.delete(botId);
  clearTimeout(tunnel.expiry);
  if (tunnel.child.exitCode === null && !tunnel.child.killed) tunnel.child.kill("SIGTERM");
  return true;
}

export function closeVpsDesktopTunnel(botId: string) {
  return { closed: stopDesktopTunnel(botId) };
}

export function closeAllVpsDesktopTunnels(): void {
  for (const botId of desktopTunnels.keys()) stopDesktopTunnel(botId);
}

/** Open a temporary noVNC connection through the configured SSH alias. The
 * returned URL is loopback-only and contains the per-container password in
 * its fragment (never sent in HTTP). Closing the app viewer calls the paired
 * close endpoint, and process shutdown closes every remaining child. */
export async function vpsComputerJoin(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ joinUrl: string; state: "running" }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });

  const existing = desktopTunnels.get(botId);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return { joinUrl: existing.joinUrl, state: "running" };
  }
  stopDesktopTunnel(botId);

  // Always re-inspect here. A cached IP or password from before a container
  // replacement is exactly the sort of secret-bearing stale state a viewer
  // endpoint must not reuse.
  const status = await computeVpsComputerStatus(cfg, botId, runner);
  if (!status.ready) {
    throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
  }
  const connection = viewerConnections.get(`${alias}:${status.container_name}`);
  if (!connection) {
    throw Object.assign(
      new Error("This VPS computer predates secure live desktop access — replace its managed container once"),
      { status: 409 },
    );
  }

  const localPort = await unusedLoopbackPort();
  const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
  const child = spawn("ssh", vpsSshTunnelArgs(alias, localPort, connection.privateIp, ssh.configPath), {
    shell: false,
    env: { ...process.env, PATH: ssh.path },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let failure: string | null = null;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-1000);
  });
  child.once("error", (error) => {
    failure = error.message;
  });
  child.once("close", (code) => {
    const active = desktopTunnels.get(botId);
    if (active?.child === child) {
      clearTimeout(active.expiry);
      desktopTunnels.delete(botId);
    }
    if (!failure) failure = stderr.trim() || `SSH viewer tunnel exited ${code ?? "without a status"}`;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !failure) {
    if (await loopbackAnswers(localPort)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (failure || !(await loopbackAnswers(localPort))) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    const detail = failure || stderr.trim() || "the SSH port forward did not become ready";
    throw Object.assign(new Error(`Could not open the VPS live desktop: ${detail}`), { status: 502 });
  }

  const joinUrl = `http://127.0.0.1:${localPort}/vnc.html#autoconnect=true&resize=scale&password=${encodeURIComponent(connection.password)}`;
  // Viewer-close is the normal cleanup. This unref'd ceiling is a backstop
  // for a renderer crash or an old browser client that cannot signal close.
  const expiry = setTimeout(() => stopDesktopTunnel(botId), 8 * 60 * 60_000);
  expiry.unref?.();
  desktopTunnels.set(botId, { child, joinUrl, expiry });
  return { joinUrl, state: "running" };
}
