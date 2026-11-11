// BYO Linux VPS: Docker's SSH transport reaches the user's daemon; one Cua MCP container per bot.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer, type AddressInfo, type Socket, type Server as TcpServer } from "node:net";

import {
  BASE_IMAGE,
  CUA_DRIVER_VERSION,
  CUA_SOCKET,
  IMAGE as CUA_IMAGE,
  cuaExecArgs,
  imageLabelsMatch,
  managedImageDockerfile,
  wholeScreenshot,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { desktopCapArgs, dockerSecurityIsHardened, type DockerHardeningConfig } from "./container-isolation.ts";
import { PIDS_LIMIT, raisePidsLimit } from "./container-limits.ts";
import { DATA_DIR, isValidSshAlias, vpsSshAlias, type AppConfig } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.ts";
import { loadEnvironmentId } from "./environment.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { dockerCliMissing, dockerCliMissingProblem } from "./vps-hints.ts";

export const VPS_IMAGE = CUA_IMAGE;
export const VPS_MANAGED_LABEL = "com.openmausbot.vps";
export const VPS_CONTAINER_LABEL = "com.openmausbot.container";
export const VPS_ENVIRONMENT_LABEL = "com.openmausbot.environment";
export const VPS_VIEWER_LABEL = "com.openmausbot.vps-viewer";
export const VPS_CONTAINER_PREFIX = "openmausbot-vps";
export { dockerCliInstallCommand } from "./vps-hints.ts";
// Lazy: index must finish data migration and take the writer lease before this may create the data directory.
let vpsEnvironmentIdCache: string | null = null;
function vpsEnvironmentId(): string {
  if (!vpsEnvironmentIdCache) vpsEnvironmentIdCache = loadEnvironmentId(DATA_DIR);
  return vpsEnvironmentIdCache;
}
// ssh + docker need this long to tear down a remote exec over a WAN; an orphaned exec keeps the driver socket busy.
const COMMAND_TIMEOUT_TERM_GRACE_MS = 5_000;
/** killCliTree could not confirm the tree exited even after SIGKILL: hold the caller (and its
 * lifecycle lock) this long before giving up, so an immediate retry cannot run beside the
 * straggler. Beyond this, a human must intervene — waiting longer does not help. */
const UNCONFIRMED_STOP_HOLD_MS = 5_000;
// killCliTree also waits up to one second for the forced group exit.
const COMMAND_TIMEOUT_KILL_GRACE_MS = COMMAND_TIMEOUT_TERM_GRACE_MS + 1_000;

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/i;
const MANAGED_VPS_CONTAINER_NAME = /^openmausbot-vps-[a-z0-9]{1,12}-[a-f0-9]{12}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;
const SCREENSHOT_PATH = "/tmp/openmausbot-vps-preview.png";
// The Cua XFCE base ships Pillow in /opt/venv; a container without it returns the original PNG.
const SCREENSHOT_TRANSFER = `/opt/venv/bin/python -I -c 'import base64, io, sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    image.thumbnail((1280, 1280))
    output = io.BytesIO()
    image.convert("RGB").save(output, format="JPEG", quality=70)
sys.stdout.write(base64.b64encode(output.getvalue()).decode("ascii"))' "$1" 2>/dev/null || { base64 < "$1" | tr -d "\\n"; }`;
const INTERNAL_VIEWER_PORT = 6901;
const VIEWER_VERSION = "1";
const lifecycleLocks = new Map<string, Promise<void>>();

/** The app config reloads in place: across awaits it could inspect one host and mutate another. */
function snapshotVpsConfig(cfg: AppConfig): AppConfig {
  const sshAlias = vpsTransportAlias(cfg);
  return sshAlias ? { vps: { sshAlias } } : {};
}

export function vpsLifecycleBusy(): boolean {
  return lifecycleLocks.size > 0;
}
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const STATUS_CACHE_TTL_MS = 10_000;
const statusCache = new Map<string, { status: VpsComputerStatus; expiresAt: number }>();
const pendingStatuses = new Map<string, Promise<VpsComputerStatus>>();
const pendingProvisions = new Map<string, Promise<VpsComputerStatus>>();
const SCREENSHOT_BUDGET_MS = 45_000;
const SCREENSHOT_CLEANUP_BUDGET_MS = 10_000;
const PREPARATION_LOCK_TIMEOUT_MS = SCREENSHOT_BUDGET_MS + LOCK_ACQUIRE_TIMEOUT_MS;
type VpsScreenshot = { png: string; format: "png" | "jpeg" };
const pendingScreenshots = new Map<string, Promise<VpsScreenshot>>();
const viewerConnections = new Map<string, { privateIp: string; password: string }>();
const REMOTE_VIEWER_GRACE_MS = 30_000;
const NATIVE_VIEWER_LIFETIME_MS = 8 * 60 * 60_000;
const desktopTunnels = new Map<
  string,
  { child: TunnelHandle; joinUrl: string; expiry: ReturnType<typeof setTimeout>; viewers: number; localViewer: boolean; containerName: string; containerId: string | null }
>();
// A join that has not published its tunnel yet: viewer close during its awaits must cancel the
// publish, or the tunnel would outlive the close for its full lifetime with nothing to stop it.
const pendingTunnelJoins = new Map<string, { cancelled: boolean }>();

function invalidateVpsStatus(key: string): void {
  statusCache.delete(key);
  // An inspection begun before a mutation must not be joined or republish its result after it.
  pendingStatuses.delete(key);
}

export interface VpsCommandOptions {
  input?: string;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type VpsLifecycleAction = "provision" | "start" | "stop" | "remove";

export function vpsStartsForTurn(input: { wants: "cloud" | "vm" | "local" | "off" | undefined; autoStartVps?: boolean; automationSource?: string }): boolean {
  if (input.wants === "cloud") return true;
  if (input.wants !== undefined) return false;
  return input.autoStartVps === true || Boolean(input.automationSource);
}

export function vpsUnavailableHint(input: { automationSource?: string; autoStartVps?: boolean; reachable?: boolean }): string {
  if (input.automationSource) return "This scheduled run tried to start the VPS computer and could not reach it. Check the VPS connection in Settings → API keys.";
  if (input.autoStartVps || input.reachable === false) return "Check the VPS connection in Settings → API keys.";
  return input.reachable ? "Open Computer and enable Start VPS automatically, or choose Cloud computer to start it manually." : "";
}

export interface VpsComputerStatus {
  configured: boolean;
  sshAlias: string | null;
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "private" | "unsafe" | "unknown";
  mounts: "none" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  container_id: string | null;
  image_id: string | null;
}

export interface ManagedVpsOwner {
  botId: string;
  name: string;
  inUse: boolean;
}

export interface ManagedVpsInventoryInstance {
  name: string;
  state: "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead" | "unknown";
  /** The SSH alias whose host holds this container. */
  vpsAlias: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedVpsInventory {
  configured: boolean;
  available: boolean;
  /** Every alias the listing covers: the default first, then each bot's own. */
  vpsAliases: string[];
  problem: string | null;
  instances: ManagedVpsInventoryInstance[];
}

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

/** A same-host Docker socket URL (e.g. unix:///var/run/docker.sock) set explicitly for this
 * deployment; a generic DOCKER_HOST must not silently reroute remote VPS aliases to the
 * local daemon. */
export function localDockerSocket(): string | null {
  const v = process.env.OMB_VPS_DOCKER_HOST;
  return v && v.startsWith("unix://") ? v : null;
}

/** Human label for the active Docker transport, so errors guide the right troubleshooting. */
function dockerTransportLabel(): string {
  return localDockerSocket() ? "Docker socket" : "Docker over SSH";
}

/** Socket-only deployments (server in a container, daemon on the same host) may have no SSH
 * alias at all; a stable placeholder keeps every alias-keyed path — locks, caches, connection
 * records — working while Docker itself routes through the socket. */
const VPS_SOCKET_ALIAS = "docker-socket";
function vpsTransportAlias(cfg: AppConfig): string | null {
  return vpsSshAlias(cfg) ?? (localDockerSocket() ? VPS_SOCKET_ALIAS : null);
}

export function vpsDockerArgs(alias: string, args: string[]): string[] {
  if (!isValidSshAlias(alias)) {
    throw new Error("invalid VPS SSH config alias");
  }
  const socket = localDockerSocket();
  if (socket) return ["-H", socket, ...args];
  return ["-H", `ssh://${alias}`, ...args];
}

/** Never published by Docker: SSH forwards one loopback port to noVNC, and every caller-controlled part is validated before argv. */
export function vpsSshTunnelArgs(alias: string, localPort: number, privateIp: string, configPath: string | null = null): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid VPS SSH config alias");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error("invalid VPS viewer port");
  }
  if (!privateDockerIpv4(privateIp)) throw new Error("invalid VPS private container address");
  return [
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
    // A viewer tunnel must stay in the foreground: the spawned SSH is kept alive by
    // the server's child-process tracking. On Linux, ControlMaster (from any config
    // the person or prepareVpsSsh provides) makes SSH fork a background connection
    // broker and exit 0 immediately — Node.js sees the exit, reports the tunnel as
    // failed, and kills the process group. macOS OpenSSH does not fork in -N mode,
    // which is why this only surfaces in containerised / Linux deployments.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPersist=no",
    // An existing ControlMaster from the user's SSH config can still own the
    // forward; ControlPath=none prevents the viewer from sharing any master,
    // so the spawned child alone owns the tunnel lifecycle.
    "-o",
    "ControlPath=none",
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
      // SAFETY: bound to an IPv4 TCP address above, so Node returns AddressInfo, not a socket path.
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

function teardownDesktopTunnel(botId: string): boolean {
  const tunnel = desktopTunnels.get(botId);
  if (!tunnel) return false;
  desktopTunnels.delete(botId);
  clearTimeout(tunnel.expiry);
  if (tunnel.child.exitCode === null && !tunnel.child.killed) tunnel.child.kill("SIGTERM");
  return true;
}

/** Viewer close and lifecycle teardown: also cancels a join that has not published yet, so a
 * tunnel can never appear after the close that should have stopped it. */
function stopDesktopTunnel(botId: string): boolean {
  const pending = pendingTunnelJoins.get(botId);
  if (pending) pending.cancelled = true;
  return teardownDesktopTunnel(botId) || Boolean(pending);
}

export function closeVpsDesktopTunnel(botId: string) {
  const tunnel = desktopTunnels.get(botId);
  if (tunnel?.viewers) {
    tunnel.localViewer = false;
    clearTimeout(tunnel.expiry);
    return { closed: false };
  }
  return { closed: stopDesktopTunnel(botId) };
}

export function closeAllVpsDesktopTunnels(): void {
  for (const botId of new Set([...desktopTunnels.keys(), ...pendingTunnelJoins.keys()])) stopDesktopTunnel(botId);
}

export function vpsDesktopConnection(botId: string) {
  const tunnel = desktopTunnels.get(botId);
  if (!tunnel || tunnel.child.exitCode !== null || tunnel.child.killed) return;
  const url = new URL(tunnel.joinUrl);
  return {
    port: Number(url.port),
    password: new URLSearchParams(url.hash.slice(1)).get("password"),
    live: () => desktopTunnels.get(botId) === tunnel && tunnel.child.exitCode === null && !tunnel.child.killed,
    retain: () => {
      tunnel.viewers++;
      if (!tunnel.localViewer) clearTimeout(tunnel.expiry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        tunnel.viewers--;
        if (!tunnel.viewers && !tunnel.localViewer && desktopTunnels.get(botId) === tunnel) {
          tunnel.expiry = setTimeout(() => {
            if (desktopTunnels.get(botId) === tunnel) stopDesktopTunnel(botId);
          }, REMOTE_VIEWER_GRACE_MS);
          tunnel.expiry.unref();
        }
      };
    },
  };
}

const STREAM_CAP_CHARS = 16 * 1024 * 1024;

function tailCollector() {
  const chunks: string[] = [];
  let total = 0;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      total += chunk.length;
      for (;;) {
        const first = chunks[0];
        if (chunks.length < 2 || first === undefined || total - first.length < STREAM_CAP_CHARS) break;
        chunks.shift();
        total -= first.length;
      }
    },
    text(): string {
      return chunks.join("").slice(-STREAM_CAP_CHARS);
    },
  };
}

export async function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  // A local socket needs no SSH shim: skip prepareVpsSsh so an inaccessible SSH
  // directory cannot break socket-based Docker commands.
  const socket = localDockerSocket();
  const ssh = socket ? { path: augmentedPath(), configPath: null } : prepareVpsSsh(DATA_DIR, augmentedPath());
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  // Like upstream's runner: bring up (or reuse) the shared master before Docker spawns, or a
  // cold burst would make every command authenticate its own SSH connection. A rejected warmup
  // must not stop Docker itself: a restricted key can permit `docker system dial-stdio` while
  // rejecting the warmup probe, and the command may still succeed on its own connection.
  const destination = args[0] === "-H" && args[1]?.startsWith("ssh://") ? args[1]!.slice(6) : null;
  // Reserve at least half the budget (and up to 30s) for Docker itself: a cold warmup that
  // exhausts the whole command budget would fail before Docker ever gets to try, even when
  // the daemon is reachable once the connection exists.
  const warmupBudget = Math.min(30_000, Math.floor(Math.max(0, deadline - Date.now()) / 2));
  if (destination && warmupBudget > 0) await Promise.resolve(ensureVpsSshMaster(ssh, destination, warmupBudget)).catch(() => undefined);
  if (Date.now() >= deadline) throw new Error(`${dockerTransportLabel()} command timed out`);
  return new Promise((resolve, reject) => {
    const child = spawnCli("docker", args, {
      shell: false,
      env: { ...process.env, PATH: ssh.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let settled = false;
    let failure: Error | null = null;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };
    const fail = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timeout);
      // ssh can hold these pipes after Docker exits; stop only this command's process group (SSH masters detach from it).
      const cleaned = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() => reject(error));
      };
      void killCliTree(child, COMMAND_TIMEOUT_TERM_GRACE_MS).then((stopped) => {
        if (stopped) return cleaned();
        // Unconfirmed termination: keep this rejection (and the caller's lifecycle lock) held
        // briefly, so the next operation on the same resource cannot overlap the survivor.
        setTimeout(cleaned, UNCONFIRMED_STOP_HOLD_MS).unref?.();
      }, cleaned);
    };
    timeout = setTimeout(() => fail(new Error(`${dockerTransportLabel()} command timed out`)), Math.max(1, deadline - Date.now()));
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      fail(new Error(`${dockerTransportLabel()} stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      const hint = dockerCliMissing(error) ? `. ${dockerCliMissingProblem()}` : "";
      fail(new Error(`${dockerTransportLabel()} could not start: ${error.message}${hint}`));
    });
    child.on("close", (code, signal) => {
      if (failure) return;
      settle(() => {
        if (code === 0) return resolve({ stdout: stdout.text(), stderr: stderr.text() });
        const detail = stderr.text().trim().slice(-1000);
        reject(new Error(detail || `${dockerTransportLabel()} exited ${code ?? signal ?? "without a status"}`));
      });
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      fail(new Error(`${dockerTransportLabel()} stdin failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

function emptyStatus(botId: string, alias: string | null): VpsComputerStatus {
  return {
    configured: Boolean(alias),
    sshAlias: alias,
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    mounts: "unknown",
    security: "unknown",
    desktopReady: false,
    desktop_error: null,
    ready: false,
    problem: alias ? `${dockerTransportLabel()} is not reachable` : "Configure a VPS SSH alias in Settings → API keys",
    image_ref: VPS_IMAGE,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: vpsContainerName(botId),
    container_id: null,
    image_id: null,
  };
}

/** Docker and Podman report "No such object/image/container"; any other inspect failure is transport, not absence. */
function isMissingObjectMessage(message: string): boolean {
  return /no such (object|image|container)/i.test(message);
}

function transportFailure(message: string): string {
  if (dockerCliMissing(message)) return dockerCliMissingProblem();
  if (/timed out/i.test(message)) {
    const hint = localDockerSocket()
      ? "Check that the Docker socket is mounted and the daemon is running, then retry."
      : "Check that the VPS is online, SSH is reachable from this computer, and Docker is running on the VPS, then retry.";
    return `${dockerTransportLabel()} failed while checking the VPS: the connection timed out. ${hint} No computer was reset.`;
  }
  return `${dockerTransportLabel()} failed while checking the VPS: ${message.trim().slice(0, 200) || "unknown transport error"}`;
}

function privateDockerIpv4(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function viewerPassword(env: string[] | undefined): string | null {
  const value = env?.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length);
  return value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
}

function hasNoHostMounts(detail: {
  Mounts?: unknown;
  HostConfig?: { Binds?: string[] | null; VolumesFrom?: string[] | null };
}): boolean {
  return (
    Array.isArray(detail.Mounts) &&
    detail.Mounts.length === 0 &&
    (!detail.HostConfig?.Binds || detail.HostConfig.Binds.length === 0) &&
    (!detail.HostConfig?.VolumesFrom || detail.HostConfig.VolumesFrom.length === 0)
  );
}

function hasNoPublishedPorts(config: {
  NetworkMode?: string;
  PortBindings?: Record<string, unknown> | null;
  PublishAllPorts?: boolean;
} | undefined, networks?: Record<string, unknown> | null): boolean {
  if (!config) return false;
  const networkMode = (config.NetworkMode ?? "").toLowerCase();
  if (!["default", "bridge"].includes(networkMode)) return false;
  const attached = Object.keys(networks ?? {}).map((name) => name.toLowerCase());
  if (attached.length !== 1 || !["default", "bridge"].includes(attached[0]!)) return false;
  return (
    config.PublishAllPorts !== true &&
    !Object.values(config.PortBindings ?? {}).some((value) => Array.isArray(value) && value.length > 0)
  );
}

function statusProblem(status: VpsComputerStatus): string | null {
  if (!status.configured) return "Configure a VPS SSH alias in Settings → API keys";
  if (!status.daemonUp) return `${dockerTransportLabel()} could not reach the VPS; check the Docker connection`;
  if (!status.image) return `Prepare the pinned OpenMausBot Cua image on the VPS (Driver ${CUA_DRIVER_VERSION})`;
  if (status.container === "missing") return "No OpenMausBot container exists for this bot on the VPS";
  if (!status.imageMatches) return "The VPS container uses an incompatible or untrusted OpenMausBot image";
  if (!status.managed) return "The VPS container name is occupied by a container OpenMausBot did not create";
  if (status.network === "unsafe") return "The VPS container uses an unapproved network or publishes ports; refusing to use it";
  if (status.mounts === "unsafe") return "The VPS container has host mounts; refusing to use it";
  if (status.security === "unsafe") return "The VPS container has unsupported privilege, isolation, or automatic-removal settings";
  if (status.container === "stopped") return "The OpenMausBot VPS container is stopped";
  if (status.desktop_error) return `The VPS Cua desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The VPS container started, but Cua Driver is not ready yet";
  return null;
}

async function computeVpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsTransportAlias(cfg);
  const status = emptyStatus(botId, alias);
  if (!alias) return status;
  viewerConnections.delete(`${alias}:${status.container_name}`);
  const run = (args: string[], timeoutMs = 10_000, input?: string) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs, input });
  // Retry only read-only inspections, never an exec or mutation whose outcome a lost connection hides.
  const inspect = async (args: string[]) => {
    try { return await run(args); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out|connection reset by peer|broken pipe/i.test(message)) throw error;
      return run(args);
    }
  };

  let inspectedImageId: string | null = null;
  try {
    const inspected = JSON.parse((await inspect(["image", "inspect", VPS_IMAGE])).stdout) as Array<{
      Id?: string;
      id?: string;
      Config?: { Labels?: Record<string, string> };
      config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    }>;
    status.daemonUp = true;
    const image = inspected[0];
    const labels = image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels;
    const imageId = image?.Id ?? image?.id;
    inspectedImageId = imageId && IMAGE_ID.test(imageId) ? imageId : null;
    status.image_id = inspectedImageId;
    status.image = Boolean(inspectedImageId) && imageLabelsMatch(labels);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isMissingObjectMessage(message)) {
      status.problem = transportFailure(message);
      return status;
    }
    status.daemonUp = true;
    status.image = false;
  }

  try {
    const inspected = JSON.parse((await inspect(["inspect", status.container_name])).stdout) as Array<{
      Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
      HostConfig?: DockerHardeningConfig & {
        Binds?: string[] | null;
        VolumesFrom?: string[] | null;
        NetworkMode?: string;
        PortBindings?: Record<string, unknown> | null;
        PublishAllPorts?: boolean;
      };
      Id?: string;
      id?: string;
      Image?: string;
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null };
      Mounts?: unknown;
      State?: { Running?: boolean };
    }>;
    const detail = inspected[0];
    const labels = detail?.Config?.Labels;
    const containerId = detail?.Id ?? detail?.id;
    status.container_id = containerId && CONTAINER_ID.test(containerId) ? containerId : null;
    status.container = detail?.State?.Running ? "running" : "stopped";
    status.imageMatches =
      status.image &&
      Boolean(status.container_id) &&
      (detail?.Config?.Image === VPS_IMAGE || detail?.Config?.Image === inspectedImageId) &&
      Boolean(inspectedImageId) &&
      detail?.Image === inspectedImageId &&
      imageLabelsMatch(labels) &&
      labels?.[VPS_VIEWER_LABEL] === VIEWER_VERSION;
    const environmentLabel = labels?.[VPS_ENVIRONMENT_LABEL];
    status.managed =
      labels?.[VPS_MANAGED_LABEL] === "1" &&
      labels?.[VPS_CONTAINER_LABEL] === status.container_name &&
      (environmentLabel === undefined || environmentLabel === vpsEnvironmentId());
    if (status.managed && status.container_id) raisePidsLimit(status.container_id, detail?.HostConfig?.PidsLimit, run);
    status.network = hasNoPublishedPorts(detail?.HostConfig, detail?.NetworkSettings?.Networks) ? "private" : "unsafe";
    status.mounts = hasNoHostMounts(detail ?? {}) ? "none" : "unsafe";
    status.security = dockerSecurityIsHardened(detail?.HostConfig, { restartPolicy: "any" })
      ? "hardened"
      : "unsafe";

    const connectionKey = `${alias}:${status.container_name}`;
    const privateIp = Object.values(detail?.NetworkSettings?.Networks ?? {})[0]?.IPAddress;
    const password = viewerPassword(detail?.Config?.Env);
    if (status.managed && privateIp && privateDockerIpv4(privateIp) && password) {
      viewerConnections.set(connectionKey, { privateIp, password });
    } else {
      viewerConnections.delete(connectionKey);
    }

    const containerRef = status.container_id;
    const canProbe =
      status.container === "running" &&
      status.image &&
      status.imageMatches &&
      status.managed &&
      status.network === "private" &&
      status.mounts === "none" &&
      status.security === "hardened";
    if (canProbe && containerRef) {
      try {
        const version = await run(cuaExecArgs(["--version"], { container: containerRef }));
        if (version.stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) throw new Error("unexpected Cua Driver version");
        await run(cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: containerRef }));
        const health = await run(
          cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: containerRef }),
          15_000,
        );
        const report = JSON.parse(health.stdout) as {
          schema_version?: string;
          overall?: string;
          checks?: unknown[];
        };
        if (
          report.schema_version !== "1" ||
          !Array.isArray(report.checks) ||
          (report.overall !== "ok" && report.overall !== "degraded")
        ) {
          throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
        }
        await run(
          cuaExecArgs(["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET], { container: containerRef }),
          20_000,
        );
        status.desktopReady = true;
      } catch (error) {
        status.desktopReady = false;
        status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
        try {
          const errorLog = await run(
            ["exec", containerRef, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
            10_000,
          );
          status.desktop_error =
            errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) || status.desktop_error;
        } catch {
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingObjectMessage(message)) {
      status.container = "missing";
    } else {
      status.daemonUp = false;
      status.problem = transportFailure(message);
      return status;
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

export async function vpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const key = vpsLockKey(cfg, botId);
  const cacheable = runner === defaultRunner && key !== null;
  if (cacheable) {
    const capture = pendingScreenshots.get(key);
    if (capture) await capture.catch(() => {});
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
    const pending = pendingStatuses.get(key);
    if (pending) return pending;
  }
  const inspection = computeVpsComputerStatus(cfg, botId, runner);
  if (cacheable) pendingStatuses.set(key, inspection);
  try {
    const status = await inspection;
    if (cacheable && pendingStatuses.get(key) === inspection && !lifecycleLocks.has(key)) {
      statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    }
    return status;
  } finally {
    if (cacheable && pendingStatuses.get(key) === inspection) pendingStatuses.delete(key);
  }
}

const VPS_INVENTORY_LIMIT = 256;
const VPS_INVENTORY_STATES = new Set<ManagedVpsInventoryInstance["state"]>([
  "created",
  "restarting",
  "running",
  "removing",
  "paused",
  "exited",
  "dead",
]);

type ManagedVpsAliasScan = Pick<ManagedVpsInventory, "available" | "problem" | "instances"> & { containerIds: Map<string, string> };

function inventoryFailure(alias: string, error: unknown): ManagedVpsAliasScan {
  if (dockerCliMissing(error)) {
    return { available: false, problem: `${dockerCliMissingProblem()} (VPS host: ${alias})`, instances: [], containerIds: new Map() };
  }
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    available: false,
    problem: `${dockerTransportLabel()} could not list managed computers on ${alias}${detail ? `: ${detail}` : ""}`,
    instances: [],
    containerIds: new Map(),
  };
}

function managedVpsState(value: unknown, running: unknown): ManagedVpsInventoryInstance["state"] {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  if (VPS_INVENTORY_STATES.has(state as ManagedVpsInventoryInstance["state"])) {
    return state as ManagedVpsInventoryInstance["state"];
  }
  if (running === true) return "running";
  if (running === false) return "exited";
  return "unknown";
}

async function scanManagedVpsAlias(
  alias: string,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner,
): Promise<ManagedVpsAliasScan> {
  try {
    const listed = await runner(vpsDockerArgs(alias, [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${VPS_MANAGED_LABEL}=1`,
      "--format",
      "{{.ID}}",
    ]), { timeoutMs: 20_000 });
    const ids = [...new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (ids.length > VPS_INVENTORY_LIMIT || ids.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("the VPS returned an invalid or unexpectedly large managed-container list");
    }
    if (ids.length === 0) {
      return { available: true, problem: null, instances: [], containerIds: new Map() };
    }

    // Project only the fields the inventory reads: a full `docker inspect` of every managed
    // container can outgrow the runner's output cap and truncate the JSON prefix; one small
    // object per line stays kilobytes even at the inventory limit.
    const inspected = await runner(
      vpsDockerArgs(alias, [
        "container",
        "inspect",
        ...ids,
        "--format",
        '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"Status":{{json .State.Status}},"Running":{{json .State.Running}}}',
      ]),
      { timeoutMs: 20_000 },
    );
    const details = inspected.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    if (details.length !== ids.length) {
      throw new Error("the VPS returned an incomplete managed-container inventory");
    }

    const ownerByName = new Map(owners.map((owner) => [vpsContainerName(owner.botId), owner]));
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const containerIds = new Map<string, string>();
    const instances: ManagedVpsInventoryInstance[] = [];
    for (const raw of details) {
      if (!raw || typeof raw !== "object") throw new Error("the VPS returned a malformed managed container");
      const detail = raw as {
        Id?: unknown;
        Name?: unknown;
        Labels?: unknown;
        Status?: unknown;
        Running?: unknown;
      };
      const id = typeof detail.Id === "string" ? detail.Id.toLowerCase() : "";
      const name = typeof detail.Name === "string" ? detail.Name.replace(/^\//, "") : "";
      const labels = detail.Labels;
      const listedId = ids.find((candidate) => id.startsWith(candidate.toLowerCase()));
      if (
        !FULL_CONTAINER_ID.test(id) ||
        !listedId ||
        seenIds.has(listedId) ||
        !MANAGED_VPS_CONTAINER_NAME.test(name) ||
        seenNames.has(name) ||
        !labels ||
        typeof labels !== "object" ||
        (labels as Record<string, unknown>)[VPS_MANAGED_LABEL] !== "1" ||
        (labels as Record<string, unknown>)[VPS_CONTAINER_LABEL] !== name
      ) {
        throw new Error("the VPS returned a managed container whose identity could not be verified");
      }
      const owner = ownerByName.get(name);
      const environmentLabel = (labels as Record<string, unknown>)[VPS_ENVIRONMENT_LABEL];
      seenIds.add(listedId);
      seenNames.add(name);
      // Another installation may share this daemon: never return an id that would make its container removable.
      if (environmentLabel !== vpsEnvironmentId() && !(environmentLabel === undefined && owner)) {
        continue;
      }
      containerIds.set(name, id);
      instances.push({
        name,
        state: managedVpsState(detail.Status, detail.Running),
        vpsAlias: alias,
        ownerBotId: owner?.botId ?? null,
        ownerName: owner?.name ?? null,
        orphaned: !owner,
        inUse: owner?.inUse === true,
      });
    }
    if (seenIds.size !== ids.length) {
      throw new Error("the VPS returned an incomplete managed-container inventory");
    }
    return { available: true, problem: null, instances, containerIds };
  } catch (error) {
    return inventoryFailure(alias, error);
  }
}

export async function listManagedVpsComputers(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner = defaultRunner,
  vpsAliases?: string[],
): Promise<ManagedVpsInventory> {
  const defaultAlias = vpsTransportAlias(snapshotVpsConfig(cfg));
  // A socket transport reaches exactly one daemon: scanning several aliases would label that
  // one daemon's containers under every remote alias, and a removal could then delete a local
  // container in a remote alias's name. Socket mode scans only the configured target.
  const requested = localDockerSocket()
    ? defaultAlias ? [defaultAlias] : []
    : vpsAliases?.length ? vpsAliases : defaultAlias ? [defaultAlias] : [];
  const scanning = [...new Set(requested.filter(isValidSshAlias))];
  if (scanning.length === 0) {
    return { configured: false, available: false, vpsAliases: [], problem: null, instances: [] };
  }
  // Concurrently: one dead host must not delay the others behind its timeouts. Promise.all keeps
  // alias order, so the aggregate below matches the old serial loop exactly.
  const scans = await Promise.all(scanning.map((alias) => scanManagedVpsAlias(alias, owners, runner)));
  const problem = scans.find((scan) => !scan.available)?.problem ?? null;
  const instances = scans.flatMap((scan) => scan.instances).sort((left, right) =>
    Number(left.orphaned) - Number(right.orphaned) ||
    (left.ownerName ?? left.name).localeCompare(right.ownerName ?? right.name) ||
    left.vpsAlias.localeCompare(right.vpsAlias),
  );
  return { configured: true, available: scans.every((scan) => scan.available), vpsAliases: scanning, problem, instances };
}

export function vpsContainerRunArgs(
  containerName: string,
  imageRef = VPS_IMAGE,
  viewerSecret = randomBytes(18).toString("base64url"),
): string[] {
  if (!CONTAINER_NAME.test(containerName) || (imageRef !== VPS_IMAGE && !IMAGE_ID.test(imageRef))) {
    throw new Error("invalid managed VPS container or image reference");
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(viewerSecret)) throw new Error("invalid managed VPS viewer secret");
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${VPS_MANAGED_LABEL}=1`,
    "--label",
    `${VPS_CONTAINER_LABEL}=${containerName}`,
    "--label",
    `${VPS_ENVIRONMENT_LABEL}=${vpsEnvironmentId()}`,
    "--label",
    `${VPS_VIEWER_LABEL}=${VIEWER_VERSION}`,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--cpus",
    "2",
    "--pids-limit", String(PIDS_LIMIT),
    "--network",
    "bridge",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    // No host mounts, so root in this desktop can install packages without reaching the host's files.
    ...desktopCapArgs("docker"),
    "--shm-size",
    "512m",
    // Without a restart policy Docker leaves the container down after a VPS reboot; unless-stopped still honors Stop.
    "--restart",
    "unless-stopped",
    "-e",
    `VNC_PW=${viewerSecret}`,
    imageRef,
  ];
}

function assertUsableContainer(status: VpsComputerStatus) {
  if (
    !status.image ||
    !status.imageMatches ||
    !status.managed ||
    status.network !== "private" ||
    status.mounts !== "none" ||
    status.security !== "hardened"
  ) {
    throw Object.assign(new Error(status.problem ?? "The existing VPS container is unsafe or incompatible"), {
      status: 409,
    });
  }
}

async function prepareVpsImage(alias: string, runner: VpsCommandRunner) {
  await runner(vpsDockerArgs(alias, ["pull", BASE_IMAGE]), { timeoutMs: 10 * 60_000 });
  await runner(vpsDockerArgs(alias, ["build", "--force-rm", "-t", VPS_IMAGE, "-"]), { // the legacy builder keeps a failed step's container without --force-rm
    input: managedImageDockerfile(),
    timeoutMs: 10 * 60_000,
  });
}

async function waitForVpsReady(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
  budgetMs = 60_000,
): Promise<VpsComputerStatus> {
  const alias = vpsTransportAlias(cfg);
  const deadline = Date.now() + budgetMs;
  let budgetExpired = false;
  const boundedRunner: VpsCommandRunner = async (args, options = {}) => {
    const remaining = deadline - Date.now() - COMMAND_TIMEOUT_KILL_GRACE_MS;
    if (remaining <= 0) {
      budgetExpired = true;
      throw new Error("VPS desktop readiness timed out");
    }
    try {
      return await runner(args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 120_000, remaining) });
    } catch (error) {
      if (Date.now() >= deadline - COMMAND_TIMEOUT_KILL_GRACE_MS) budgetExpired = true;
      throw error;
    }
  };
  let status = await computeVpsComputerStatus(cfg, botId, boundedRunner);
  let delayMs = 500;
  while (!status.ready && alias && !budgetExpired && Date.now() < deadline) {
    if (
      !status.daemonUp ||
      !status.image ||
      !status.imageMatches ||
      !status.managed ||
      status.container !== "running" ||
      status.network !== "private" ||
      status.mounts !== "none" ||
      status.security !== "hardened"
    ) {
      return status;
    }
    await new Promise((resolve) => {
      const sleep = setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now())));
      sleep.unref?.();
    });
    delayMs = Math.min(delayMs * 2, 4_000);
    const container = status.container_id ?? status.container_name;
    const driverAnswers = await boundedRunner(
      vpsDockerArgs(alias, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container })),
      { timeoutMs: 10_000 },
    ).then(
      () => true,
      () => false,
    );
    if (budgetExpired) break;
    if (!driverAnswers && Date.now() < deadline) continue;
    status = await computeVpsComputerStatus(cfg, botId, boundedRunner);
  }
  if (budgetExpired) return {
    ...status,
    ready: false,
    desktopReady: false,
    desktop_error: "VPS desktop readiness timed out",
    problem: "The VPS desktop did not become ready in time — retry when the connection recovers",
  };
  return status;
}

async function withVpsLifecycleLock<T>(key: string, operation: () => Promise<T>, acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS): Promise<T> {
  const previous = lifecycleLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleLocks.set(key, current);
  if (previous) {
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        acquireTimer = setTimeout(() => resolve(false), acquireTimeoutMs);
        acquireTimer.unref?.();
      }),
    ]);
    if (acquireTimer) clearTimeout(acquireTimer);
    if (!acquired) {
      // This slot opens only when the holder's does, so a later caller never runs beside the long operation.
      void previous.then(() => {
        release();
        if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
      });
      throw Object.assign(new Error("the VPS is being prepared — try again shortly"), { status: 409 });
    }
  }
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
  }
}

function vpsLockKey(cfg: AppConfig, botId: string): string | null {
  const alias = vpsTransportAlias(cfg);
  return alias ? `${alias}:${vpsContainerName(botId)}` : null;
}

export async function removeManagedVpsComputer(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  containerName: string,
  confirmName: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ removed: true; name: string }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsTransportAlias(cfg);
  if (!alias) {
    throw Object.assign(new Error("VPS is not configured — add an SSH config alias in Settings → API keys"), { status: 409 });
  }
  if (!MANAGED_VPS_CONTAINER_NAME.test(containerName)) {
    throw Object.assign(new Error("invalid managed VPS computer name"), { status: 400 });
  }
  const key = `${alias}:${containerName}`;
  return withVpsLifecycleLock(key, async () => {
    invalidateVpsStatus(key);
    const scan = await scanManagedVpsAlias(alias, owners, runner);
    if (!scan.available) {
      throw Object.assign(new Error(scan.problem ?? "VPS computer inventory is unavailable"), { status: 503 });
    }
    const instance = scan.instances.find((candidate) => candidate.name === containerName);
    if (!instance) throw Object.assign(new Error("managed VPS computer not found"), { status: 404 });
    if (instance.inUse) {
      throw Object.assign(new Error("this VPS computer is in use — stop its bot's work first"), { status: 409 });
    }
    if (confirmName !== instance.name) {
      throw Object.assign(new Error("confirmation no longer matches this VPS computer — refresh and try again"), { status: 400 });
    }

    const containerId = scan.containerIds.get(instance.name);
    if (!containerId || !FULL_CONTAINER_ID.test(containerId)) {
      throw Object.assign(new Error("the VPS computer identity could not be revalidated"), { status: 409 });
    }
    try {
      // The immutable ID, not the name: a same-name replacement must not receive this removal.
      await runner(vpsDockerArgs(alias, ["rm", "-f", containerId]), { timeoutMs: 2 * 60_000 });
    } catch (error) {
      invalidateVpsStatus(key);
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 200);
      throw Object.assign(
        new Error(`The VPS refused to remove this computer${detail ? `: ${detail}` : ""}`),
        { status: 502 },
      );
    }
    invalidateVpsStatus(key);
    viewerConnections.delete(key);
    if (instance.ownerBotId) stopDesktopTunnel(instance.ownerBotId);
    return { removed: true, name: instance.name };
  });
}

export async function vpsComputerAction(
  action: VpsLifecycleAction,
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsTransportAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in Settings → API keys"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const pending = action === "provision" ? pendingProvisions.get(key) : undefined;
  if (pending) return pending;
  const operation = async () => {
    invalidateVpsStatus(key);
    try {
      const before = await computeVpsComputerStatus(cfg, botId, runner);
      if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${dockerTransportLabel()} is not reachable`), { status: 409 });
      if (action === "provision" && before.ready) return before;
      if (action !== "provision" || before.container !== "running") stopDesktopTunnel(botId);
      const run = (args: string[], timeoutMs = 2 * 60_000) => runner(vpsDockerArgs(alias, args), { timeoutMs });

      const containerRef = before.container_id ?? before.container_name;
      if (action === "provision") {
        if (before.container === "missing") {
          let imageRef = before.image ? before.image_id : null;
          if (!before.image) {
            await prepareVpsImage(alias, runner);
            imageRef = (await computeVpsComputerStatus(cfg, botId, runner)).image_id;
          }
          if (!imageRef) throw Object.assign(new Error("The prepared VPS image could not be identified"), { status: 409 });
          await run(vpsContainerRunArgs(before.container_name, imageRef));
        } else {
          assertUsableContainer(before);
          if (before.container === "stopped") await run(["start", containerRef]);
        }
      } else if (action === "start") {
        if (before.container === "missing") throw Object.assign(new Error("No VPS container exists for this bot"), { status: 409 });
        if (before.container === "running") throw Object.assign(new Error("The VPS container is already running"), { status: 409 });
        assertUsableContainer(before);
        await run(["start", containerRef]);
      } else if (action === "remove") {
        // Skips the usability check (remove escapes a broken container); the ownership labels are the only gate.
        if (before.container === "missing") return before;
        if (!before.managed) {
          throw Object.assign(
            new Error("The VPS container name is occupied by a container OpenMausBot did not create — remove it on the VPS yourself"),
            { status: 409 },
          );
        }
        await run(["rm", "-f", containerRef]);
        return await computeVpsComputerStatus(cfg, botId, runner);
      } else {
        if (before.container !== "running") throw Object.assign(new Error("The VPS container is not running"), { status: 409 });
        assertUsableContainer(before);
        await run(["stop", containerRef]);
      }
      return await (action === "stop" ? computeVpsComputerStatus(cfg, botId, runner) : waitForVpsReady(cfg, botId, runner));
    } finally {
      invalidateVpsStatus(key);
    }
  };
  const preparation = withVpsLifecycleLock(key, operation, action === "provision" ? PREPARATION_LOCK_TIMEOUT_MS : LOCK_ACQUIRE_TIMEOUT_MS);
  if (action === "provision") pendingProvisions.set(key, preparation);
  try { return await preparation; }
  finally { if (pendingProvisions.get(key) === preparation) pendingProvisions.delete(key); }
}

export async function reuseVps(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus | null> {
  const status = await inspectVpsForAuto(cfg, botId, runner);
  return status.ready ? status : null;
}

/** Auto inspections in flight: a turn joins one unless a start or stop has queued behind it. */
const pendingAutoInspections = new Map<string, { inspection: Promise<VpsComputerStatus>; lock?: Promise<void>; runner: VpsCommandRunner }>();

export async function inspectVpsForAuto(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const key = vpsLockKey(cfg, botId);
  if (!key) return computeVpsComputerStatus(cfg, botId, runner);
  const pending = pendingAutoInspections.get(key);
  if (pending && pending.runner === runner && lifecycleLocks.get(key) === pending.lock) return pending.inspection;
  const inspection = withVpsLifecycleLock(key, () => computeVpsComputerStatus(cfg, botId, runner), PREPARATION_LOCK_TIMEOUT_MS);
  // withVpsLifecycleLock queues synchronously, so the newest lock slot is this inspection's own.
  const entry = { inspection, lock: lifecycleLocks.get(key), runner };
  pendingAutoInspections.set(key, entry);
  try { return await inspection; }
  finally { if (pendingAutoInspections.get(key) === entry) pendingAutoInspections.delete(key); }
}

/** The loopback URL carries the container password in its fragment, which is never sent over HTTP. */
/** The members tunnel management needs from a tunnel handle. */
export interface TunnelHandle {
  readonly exitCode: number | null;
  readonly killed: boolean;
  /** Accepts both Node's ChildProcess signals (numbers | names) and the plain names the socket proxy uses. */
  kill(signal?: string | number): void;
  once(event: "close", cb: () => void): unknown;
}

/** A TCP proxy from a loopback port to the container's noVNC port (same-host socket mode).
 * Pass 0 to let the kernel pick the port — no probe-then-bind window another listener could
 * take. Rejects if the container is unreachable; the accepted-port number comes with the handle. */
function socketViewerTunnel(localPort: number, containerIp: string): Promise<{ handle: TunnelHandle; port: number }> {
  return new Promise((resolve, reject) => {
    const server: TcpServer = createServer();
    const sockets = new Set<{ local: Socket; upstream: Socket }>();
    let closed = false;
    server.on("error", reject);
    server.on("connection", (local: Socket) => {
      const upstream = createConnection({ host: containerIp, port: 6901 });
      const pair = { local, upstream };
      sockets.add(pair);
      local.pipe(upstream);
      upstream.pipe(local);
      const cleanup = () => {
        local.destroy();
        upstream.destroy();
        sockets.delete(pair);
      };
      local.on("error", cleanup);
      upstream.on("error", cleanup);
      local.on("close", cleanup);
      upstream.on("close", cleanup);
    });
    server.listen(localPort, "127.0.0.1", () => {
      // Bound successfully; verify the container is reachable before returning.
      const probe = createConnection({ host: containerIp, port: 6901, timeout: 3000 });
      // A client that connected while the probe was pending must not outlive a failed probe.
      const failProbe = (message: string) => {
        probe.destroy();
        closed = true;
        for (const { local, upstream } of sockets) { local.destroy(); upstream.destroy(); }
        sockets.clear();
        server.close();
        reject(new Error(message));
      };
      const bound = (server.address() as AddressInfo).port;
      probe.on("connect", () => { probe.destroy(); resolve({ handle, port: bound }); });
      probe.on("error", () => failProbe(`the desktop container at ${containerIp}:6901 is not reachable`));
      probe.on("timeout", () => failProbe(`the desktop container at ${containerIp}:6901 did not respond within 3s`));
    });
    const handle: TunnelHandle = {
      get exitCode() { return closed ? 0 : null; },
      get killed() { return closed; },
      kill(_signal?: string | number) { closed = true; for (const { local, upstream } of sockets) { local.destroy(); upstream.destroy(); } server.close(); },
      once(event: string, cb: () => void) { if (event === "close") server.on("close", cb); return this; },
    };
  });
}

/** A tunnel can outlive its container: before reusing one, confirm the name still resolves to the
 * same, running container it was built for. A transport hiccup keeps the live tunnel (it either
 * works or it does not); a confirmed replacement, a stopped container, or a missing container
 * forces a rebuild. */
async function tunnelUnfitForReuse(
  alias: string,
  tunnel: { containerName: string; containerId: string | null },
  runner: VpsCommandRunner,
): Promise<boolean> {
  if (!tunnel.containerId || !CONTAINER_NAME.test(tunnel.containerName)) return false;
  try {
    const inspected = await runner(
      vpsDockerArgs(alias, ["inspect", tunnel.containerName, "--format", "{{.Id}} {{.State.Status}} {{.State.Running}}"]),
      { timeoutMs: 10_000 },
    );
    const [id, status, running] = inspected.stdout.trim().toLowerCase().split(/\s+/);
    // An external stop keeps the id but kills the desktop the tunnel forwards to; a paused
    // container still reports Running=true while its desktop cannot answer.
    return !id?.startsWith(tunnel.containerId.toLowerCase()) || status !== "running" || running !== "true";
  } catch (error) {
    return isMissingObjectMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function vpsComputerJoin(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
  remoteViewer = false,
): Promise<{ joinUrl: string; state: "running" }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsTransportAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });

  // Registered before the first await — including the tunnel-reuse recheck below — so a viewer
  // close during any part of this join cancels what it would otherwise publish or re-arm.
  const pending = { cancelled: false };
  pendingTunnelJoins.set(botId, pending);
  const closedWhileStarting = () => Object.assign(new Error("Could not open the VPS live desktop: it was closed while starting"), { status: 502 });
  try {
    const existing = desktopTunnels.get(botId);
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      const unfit = await tunnelUnfitForReuse(alias, existing, runner);
      // The recheck awaited: a viewer close may have torn this tunnel down meanwhile, so only
      // reuse the entry if it is still the live one (re-arming a detached entry's expiry timer
      // would later stop an unrelated replacement tunnel).
      const stillLive = desktopTunnels.get(botId) === existing && existing.child.exitCode === null && !existing.child.killed && !pending.cancelled;
      if (stillLive && !unfit) {
        if (!remoteViewer) existing.localViewer = true;
        if (!existing.viewers || existing.localViewer) {
          clearTimeout(existing.expiry);
          existing.expiry = setTimeout(() => stopDesktopTunnel(botId), existing.localViewer ? NATIVE_VIEWER_LIFETIME_MS : REMOTE_VIEWER_GRACE_MS);
          existing.expiry.unref();
        }
        return { joinUrl: existing.joinUrl, state: "running" };
      }
      // Unfit, or torn down by a close during the check: fall through. Teardown (not stop —
      // this join's own pending token must survive) clears the stale entry if one remains.
      teardownDesktopTunnel(botId);
    } else {
      teardownDesktopTunnel(botId); // clear a dead entry, if any
    }

    // Always re-inspect: a cached IP or password may predate a container replacement.
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
    const joinUrlFor = (localPort: number) => `http://127.0.0.1:${localPort}/vnc.html#autoconnect=true&resize=scale&password=${encodeURIComponent(connection.password)}`;
    const publish = (child: TunnelHandle, joinUrl: string) => {
      if (pending.cancelled) {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        throw closedWhileStarting();
      }
      const expiry = setTimeout(() => stopDesktopTunnel(botId), remoteViewer ? REMOTE_VIEWER_GRACE_MS : NATIVE_VIEWER_LIFETIME_MS);
      expiry.unref?.();
      desktopTunnels.set(botId, { child, joinUrl, expiry, viewers: 0, localViewer: !remoteViewer, containerName: status.container_name, containerId: status.container_id });
      return { joinUrl, state: "running" as const };
    };

    // Socket mode: direct TCP proxy to the container's noVNC port, no SSH needed.
    if (localDockerSocket()) {
      let opened: { handle: TunnelHandle; port: number };
      try {
        opened = await socketViewerTunnel(0, connection.privateIp);
      } catch (error) {
        throw Object.assign(new Error(`Could not open the VPS live desktop: ${error instanceof Error ? error.message : String(error)}`), { status: 502 });
      }
      return publish(opened.handle, joinUrlFor(opened.port));
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
    return publish(child, joinUrlFor(localPort));
  } finally {
    if (pendingTunnelJoins.get(botId) === pending) pendingTunnelJoins.delete(botId);
  }
}

export function vpsContainerMcpArgs(alias: string, containerName: string): string[] {
  if (!isValidSshAlias(alias) || (!CONTAINER_NAME.test(containerName) && !CONTAINER_ID.test(containerName))) {
    throw new Error("invalid VPS MCP connection");
  }
  return vpsDockerArgs(
    alias,
    cuaExecArgs(["mcp", "--socket", CUA_SOCKET], { container: containerName, interactive: true }),
  );
}

export function vpsComputerMcp(cfg: AppConfig, botId: string, containerRef?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const alias = vpsTransportAlias(cfg);
  if (!alias) throw new Error("VPS is not configured — add an SSH config alias first");
  const socket = localDockerSocket();
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.vpsContainerMcp, alias, containerRef ?? vpsContainerName(botId)],
    // The bridge process relies on this env to pick its transport: without it, a socket-only
    // deployment would try SSH to the placeholder alias and fail before any tool starts.
    env: { ELECTRON_RUN_AS_NODE: "1", ...(socket ? { OMB_VPS_DOCKER_HOST: socket } : {}) },
  };
}

export async function vpsComputerScreenshot(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsScreenshot> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsTransportAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const pending = pendingScreenshots.get(key);
  if (pending) return pending;
  const cacheable = runner === defaultRunner;
  const deadline = Date.now() + SCREENSHOT_BUDGET_MS;
  const workDeadline = deadline - SCREENSHOT_CLEANUP_BUDGET_MS;
  let budgetExpired = false;
  const timeoutError = () => Object.assign(new Error("The VPS screen preview timed out. Retry the preview when the connection recovers."), { status: 504 });
  // Await the runner's termination grace: racing it would release the lock before cleanup.
  const boundedRunner: VpsCommandRunner = async (args, options = {}) => {
    const remaining = workDeadline - Date.now() - COMMAND_TIMEOUT_KILL_GRACE_MS;
    if (remaining <= 0) { budgetExpired = true; throw timeoutError(); }
    try {
      const result = await runner(args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 120_000, remaining) });
      if (Date.now() >= workDeadline) { budgetExpired = true; throw timeoutError(); }
      return result;
    } catch (error) {
      if (Date.now() >= workDeadline - COMMAND_TIMEOUT_KILL_GRACE_MS) budgetExpired = true;
      throw budgetExpired ? timeoutError() : error;
    }
  };
  const capture = withVpsLifecycleLock(key, async () => {
    const cached = cacheable ? statusCache.get(key) : undefined;
    const pendingStatus = cacheable ? pendingStatuses.get(key) : undefined;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    const status =
      cached && cached.expiresAt > Date.now()
        ? cached.status
        : pendingStatus
          ? await Promise.race([
            pendingStatus,
            new Promise<never>((_resolve, reject) => {
              statusTimer = setTimeout(() => {
                invalidateVpsStatus(key);
                reject(timeoutError());
              }, Math.max(0, workDeadline - Date.now()));
              statusTimer.unref?.();
            }),
          ]).finally(() => { if (statusTimer) clearTimeout(statusTimer); })
          : await computeVpsComputerStatus(cfg, botId, boundedRunner);
    if (budgetExpired) {
      if (cacheable) statusCache.delete(key);
      throw timeoutError();
    }
    if (!status.ready) {
      if (cacheable) statusCache.delete(key);
      throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
    }
    const containerRef = status.container_id ?? status.container_name;
    // The ref goes straight into docker argv: revalidate it.
    if (!CONTAINER_ID.test(containerRef) && !CONTAINER_NAME.test(containerRef)) {
      throw Object.assign(new Error("the VPS container reference is malformed"), { status: 409 });
    }
    let frame: VpsScreenshot;
    try {
      await boundedRunner(
        vpsDockerArgs(
          alias,
          cuaExecArgs(
            ["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET, "--screenshot-out-file", SCREENSHOT_PATH],
            { container: containerRef },
          ),
        ),
        { timeoutMs: 30_000 },
      );
      const encoded = (await boundedRunner(vpsDockerArgs(alias, [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        containerRef,
        "sh",
        "-c",
        SCREENSHOT_TRANSFER,
        "openmausbot-preview",
        SCREENSHOT_PATH,
      ]), { timeoutMs: 30_000 })).stdout.trim();
      const checked = wholeScreenshot(Buffer.from(encoded, "base64"));
      if (!checked.ok) throw Object.assign(new Error("Cua Driver returned an incomplete VPS screenshot"), { status: 502 });
      frame = { png: encoded, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
    } catch (error) {
      if (cacheable) statusCache.delete(key);
      throw error;
    } finally {
      const cleanupMs = Math.min(5_000, deadline - Date.now() - COMMAND_TIMEOUT_KILL_GRACE_MS);
      if (cleanupMs > 0) await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerRef, "rm", "-f", SCREENSHOT_PATH]), {
        timeoutMs: cleanupMs,
      }).catch(() => {});
    }
    if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return frame;
  });
  pendingScreenshots.set(key, capture);
  try { return await capture; }
  finally { if (pendingScreenshots.get(key) === capture) pendingScreenshots.delete(key); }
}
