// BYO Linux VPS computer. The agent process stays local; Docker's own SSH
// transport reaches the user's daemon and the official Cua MCP server stays
// inside one managed container per bot.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";

import {
  BASE_IMAGE,
  CUA_DRIVER_VERSION,
  CUA_SOCKET,
  IMAGE as CUA_IMAGE,
  cuaExecArgs,
  dockerSecurityIsHardened,
  imageLabelsMatch,
  managedImageDockerfile,
  wholeScreenshot,
  type DockerHardeningConfig,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { DATA_DIR, isValidSshAlias, vpsSshAlias, type AppConfig } from "./config.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { loadEnvironmentId } from "./environment.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

export const VPS_IMAGE = CUA_IMAGE;
export const VPS_MANAGED_LABEL = "com.openmausbot.vps";
export const VPS_CONTAINER_LABEL = "com.openmausbot.container";
export const VPS_ENVIRONMENT_LABEL = "com.openmausbot.environment";
export const VPS_VIEWER_LABEL = "com.openmausbot.vps-viewer";
export const VPS_CONTAINER_PREFIX = "openmausbot-vps";
// The same durable id is also served by the environment discovery endpoint.
// Resolve it lazily: index must finish legacy data migration and acquire the
// writer lease before either provider may create the new data directory.
let vpsEnvironmentIdCache: string | null = null;
function vpsEnvironmentId(): string {
  if (!vpsEnvironmentIdCache) vpsEnvironmentIdCache = loadEnvironmentId(DATA_DIR);
  return vpsEnvironmentIdCache;
}
// SIGTERM must give ssh + docker time to tear down the remote exec before the
// SIGKILL escalation; 1s was routinely too short over a WAN round-trip, and an
// orphaned remote exec keeps the driver socket busy for the next command.
const COMMAND_TIMEOUT_KILL_GRACE_MS = 5_000;

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/i;
const MANAGED_VPS_CONTAINER_NAME = /^openmausbot-vps-[a-z0-9]{1,12}-[a-f0-9]{12}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;
const PIDS_LIMIT = 512;
const SCREENSHOT_PATH = "/tmp/openmausbot-vps-preview.png";
const INTERNAL_VIEWER_PORT = 6901;
const VIEWER_VERSION = "1";
const lifecycleLocks = new Map<string, Promise<void>>();

/** Pin one SSH destination for a complete provider operation. The shared app
 * config is reloaded in place, so retaining it across awaits could otherwise
 * inspect one host and start/remove a container on another. */
function snapshotVpsConfig(cfg: AppConfig): AppConfig {
  const sshAlias = vpsSshAlias(cfg);
  return sshAlias ? { vps: { sshAlias } } : {};
}

/** Settings uses this as the reverse side of its config-transition lock: an
 * alias cannot move while a lifecycle action that started first still owns a
 * container lock, including ownerless inventory removals. */
export function vpsLifecycleBusy(): boolean {
  return lifecycleLocks.size > 0;
}
// A held lock means a lifecycle mutation (worst case: a 10-minute image
// build) is running. Waiting it out would wedge Sleep and the screenshot
// poll behind it, so acquisition fails fast instead.
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
// The panel polls status every 4-6s and the screen poller re-checks it before
// every frame; each full status is several docker-over-SSH processes. Same
// pattern as container-computer's screenshotStatusCache, and the same TTL.
const STATUS_CACHE_TTL_MS = 10_000;
const statusCache = new Map<string, { status: VpsComputerStatus; expiresAt: number }>();
const viewerConnections = new Map<string, { privateIp: string; password: string }>();
const desktopTunnels = new Map<
  string,
  { child: ReturnType<typeof spawn>; joinUrl: string; expiry: ReturnType<typeof setTimeout> }
>();

export interface VpsCommandOptions {
  input?: string;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type VpsLifecycleAction = "provision" | "start" | "stop" | "remove";

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
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedVpsInventory {
  configured: boolean;
  available: boolean;
  sshAlias: string | null;
  problem: string | null;
  instances: ManagedVpsInventoryInstance[];
}

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

/** Stable across restarts and independent of the bot's editable display name. */
export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

export function vpsDockerArgs(alias: string, args: string[]): string[] {
  if (!isValidSshAlias(alias)) {
    throw new Error("invalid VPS SSH config alias");
  }
  return ["-H", `ssh://${alias}`, ...args];
}

/** A live VPS desktop is never published by Docker. SSH binds one temporary
 * loopback port on this computer and forwards it to noVNC on the container's
 * private bridge address. Every caller-controlled component is validated
 * before it becomes an argv value. */
export function vpsSshTunnelArgs(alias: string, localPort: number, privateIp: string): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid VPS SSH config alias");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error("invalid VPS viewer port");
  }
  if (!privateDockerIpv4(privateIp)) throw new Error("invalid VPS private container address");
  return [
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

function stopDesktopTunnel(botId: string): boolean {
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

const STREAM_CAP_CHARS = 16 * 1024 * 1024;

/** Keeps the LAST 16MB of a stream without rebuilding one giant string per
 * chunk (a 10-minute `docker build` stream made that rebuild quadratic).
 * Chunks fall off the front as soon as the tail alone covers the cap; the
 * final slice preserves the exact cap semantics of the old accumulator. */
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

export function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = resolveCliSpawn("docker", args);
    const child = spawn(command.command, command.args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      finish();
    };
    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
      killTimer.unref?.();
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);
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
      if (timedOut) return;
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error.message}`)));
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(`Docker-over-SSH could not start: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
        return;
      }
      settle(() => {
        if (code === 0) return resolve({ stdout: stdout.text(), stderr: stderr.text() });
        const detail = stderr.text().trim().slice(-1000);
        reject(new Error(detail || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`));
      });
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`)));
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
    problem: alias ? "Docker over SSH is not reachable" : "Configure a VPS SSH alias in App Settings → Connections",
    image_ref: VPS_IMAGE,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: vpsContainerName(botId),
    container_id: null,
    image_id: null,
  };
}

/** Docker and Podman both phrase a clean not-found this way ("No such
 * object" / "No such image" / "no such container"); anything else out of an
 * inspect is a transport or daemon failure and must NOT be read as absence —
 * a flaky WAN link that looked like "missing" used to send provision into
 * `docker run --name <existing>` and a baffling name-in-use error. */
function isMissingObjectMessage(message: string): boolean {
  return /no such (object|image|container)/i.test(message);
}

function transportFailure(message: string): string {
  return `Docker over SSH failed while checking the VPS: ${message.trim().slice(0, 200) || "unknown transport error"}`;
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
  if (!status.configured) return "Configure a VPS SSH alias in App Settings → Connections";
  if (!status.daemonUp) return "Docker over SSH could not reach the VPS; check the SSH alias and Docker on the VPS";
  if (!status.image) return `Prepare the pinned OpenMausBot Cua image on the VPS (Driver ${CUA_DRIVER_VERSION})`;
  if (status.container === "missing") return "No OpenMausBot container exists for this bot on the VPS";
  if (!status.imageMatches) return "The VPS container uses an incompatible or untrusted OpenMausBot image";
  if (!status.managed) return "The VPS container name is occupied by a container OpenMausBot did not create";
  if (status.network === "unsafe") return "The VPS container uses an unapproved network or publishes ports; refusing to use it";
  if (status.mounts === "unsafe") return "The VPS container has host mounts; refusing to use it";
  if (status.security === "unsafe") return "The VPS container is missing OpenMausBot safety limits";
  if (status.container === "stopped") return "The OpenMausBot VPS container is stopped";
  if (status.desktop_error) return `The VPS Cua desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The VPS container started, but Cua Driver is not ready yet";
  return null;
}

/** The uncached inspection. Lifecycle mutations and their readiness waits
 * call this directly — they must see and publish the truth, never a poll's
 * snapshot; the exported vpsComputerStatus wraps it with the poll cache.
 *
 * `docker info` is deliberately NOT probed as its own round-trip: every
 * docker-over-SSH invocation is a full process + SSH connection, and the
 * image inspect right below already proves the daemon answers — even its
 * "No such image" failure is a daemon reply. Anything that is neither JSON
 * nor a "no such object" reply is attributed to the transport instead. */
async function computeVpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const status = emptyStatus(botId, alias);
  if (!alias) return status;
  viewerConnections.delete(`${alias}:${status.container_name}`);
  const run = (args: string[], timeoutMs = 10_000, input?: string) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs, input });

  let inspectedImageId: string | null = null;
  try {
    const inspected = JSON.parse((await run(["image", "inspect", VPS_IMAGE])).stdout) as Array<{
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
    // A clean "no such image" is still a daemon answer.
    status.daemonUp = true;
    status.image = false;
  }

  try {
    const inspected = JSON.parse((await run(["inspect", status.container_name])).stdout) as Array<{
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
      // A bot-scoped status is proof that the deterministic legacy container
      // still maps to a bot present in this installation. New containers must
      // carry this installation's durable environment label.
      (environmentLabel === undefined || environmentLabel === vpsEnvironmentId());
    status.network = hasNoPublishedPorts(detail?.HostConfig, detail?.NetworkSettings?.Networks) ? "private" : "unsafe";
    status.mounts = hasNoHostMounts(detail ?? {}) ? "none" : "unsafe";
    status.security = dockerSecurityIsHardened(detail?.HostConfig, { restartPolicy: "unless-stopped" })
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
        // The desktop must ANSWER, not render: get_desktop_state succeeding
        // is the readiness proof. The Local VM also pulls a pixel-validated
        // readiness screenshot because a local exec is free; over SSH that is
        // a full-frame base64 transfer on every status poll, so pixel
        // validation lives solely in vpsComputerScreenshot().
        await run(
          cuaExecArgs(["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET], { container: containerRef }),
          20_000,
        );
        status.desktopReady = true;
      } catch (error) {
        status.desktopReady = false;
        status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
        // Mirror the Local VM's probe: when the desktop fails, the
        // supervisor's error log says WHY — a bounded tail turns an endless
        // "not ready yet" into something the user can act on.
        try {
          const errorLog = await run(
            ["exec", containerRef, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
            10_000,
          );
          status.desktop_error =
            errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) || status.desktop_error;
        } catch {
          // The log may not exist during the first seconds of container boot.
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

/** Poll-facing status. Real SSH invocations (the default runner) are served
 * from a short TTL cache — the panel and the screen poller each re-check
 * every few seconds, and without the cache one healthy poll cycle cost a
 * dozen SSH connections. Injected runners (tests, lifecycle internals)
 * always recompute. */
export async function vpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const key = vpsLockKey(cfg, botId);
  const cacheable = runner === defaultRunner && key !== null;
  if (cacheable) {
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
  }
  const status = await computeVpsComputerStatus(cfg, botId, runner);
  if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return status;
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

function inventoryFailure(alias: string, error: unknown): ManagedVpsInventory {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    configured: true,
    available: false,
    sshAlias: alias,
    problem: `Docker over SSH could not list managed computers${detail ? `: ${detail}` : ""}`,
    instances: [],
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

/** Read-only account inventory for Settings. This intentionally uses only
 * `container ls` and `container inspect`: opening Settings must never create,
 * start, stop, or probe a desktop. The second managed label and deterministic
 * name are both revalidated before a container is shown as removable. */
async function scanManagedVpsComputers(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ inventory: ManagedVpsInventory; containerIds: Map<string, string> }> {
  const alias = vpsSshAlias(cfg);
  if (!alias) {
    return {
      inventory: { configured: false, available: false, sshAlias: null, problem: null, instances: [] },
      containerIds: new Map(),
    };
  }

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
      return {
        inventory: { configured: true, available: true, sshAlias: alias, problem: null, instances: [] },
        containerIds: new Map(),
      };
    }

    const inspected = await runner(
      vpsDockerArgs(alias, ["container", "inspect", ...ids]),
      { timeoutMs: 20_000 },
    );
    const details = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(details) || details.length !== ids.length) {
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
        Config?: { Labels?: unknown };
        State?: { Status?: unknown; Running?: unknown };
      };
      const id = typeof detail.Id === "string" ? detail.Id.toLowerCase() : "";
      const name = typeof detail.Name === "string" ? detail.Name.replace(/^\//, "") : "";
      const labels = detail.Config?.Labels;
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
      // A foreign installation can legitimately share this Docker daemon and
      // therefore appears in the label-filtered provider response. Count the
      // row as inspected, but never return an identifier that could make it
      // removable. Unlabelled pre-environment containers remain manageable
      // only while their deterministic name still maps to a local bot.
      if (environmentLabel !== vpsEnvironmentId() && !(environmentLabel === undefined && owner)) {
        continue;
      }
      containerIds.set(name, id);
      instances.push({
        name,
        state: managedVpsState(detail.State?.Status, detail.State?.Running),
        ownerBotId: owner?.botId ?? null,
        ownerName: owner?.name ?? null,
        orphaned: !owner,
        inUse: owner?.inUse === true,
      });
    }
    if (seenIds.size !== ids.length) {
      throw new Error("the VPS returned an incomplete managed-container inventory");
    }
    instances.sort((left, right) =>
      Number(left.orphaned) - Number(right.orphaned) ||
      (left.ownerName ?? left.name).localeCompare(right.ownerName ?? right.name),
    );
    return {
      inventory: { configured: true, available: true, sshAlias: alias, problem: null, instances },
      containerIds,
    };
  } catch (error) {
    return { inventory: inventoryFailure(alias, error), containerIds: new Map() };
  }
}

export async function listManagedVpsComputers(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner = defaultRunner,
): Promise<ManagedVpsInventory> {
  cfg = snapshotVpsConfig(cfg);
  return (await scanManagedVpsComputers(cfg, owners, runner)).inventory;
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
    "--pids-limit",
    String(PIDS_LIMIT),
    "--network",
    "bridge",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--shm-size",
    "512m",
    // A VPS reboots with nobody watching; without a restart policy the
    // container stays down afterwards and every turn silently degrades until
    // someone opens the panel. unless-stopped survives reboots while still
    // honoring an explicit Stop. The shared hardening check accepts exactly
    // this policy for the VPS caller (and only "no"/unset for the Local VM,
    // whose desktop cannot safely resume).
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
  await runner(vpsDockerArgs(alias, ["build", "-t", VPS_IMAGE, "-"]), {
    input: managedImageDockerfile(),
    timeoutMs: 10 * 60_000,
  });
}

/** Waits for the driver inside a verified, running container to come up.
 * Backoff doubles 0.5s→4s because each poll is a real SSH connection, and
 * between polls only ONE cheap exec (`cua-driver status`) asks whether the
 * driver answers yet — the full multi-invocation status runs again only when
 * that predicate flips, and once more at the deadline, so the returned state
 * is always a complete inspection. */
async function waitForVpsReady(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
  budgetMs = 60_000,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const deadline = Date.now() + budgetMs;
  let status = await computeVpsComputerStatus(cfg, botId, runner);
  let delayMs = 500;
  while (!status.ready && alias && Date.now() < deadline) {
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
    const driverAnswers = await runner(
      vpsDockerArgs(alias, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container })),
      { timeoutMs: 10_000 },
    ).then(
      () => true,
      () => false,
    );
    if (!driverAnswers && Date.now() < deadline) continue;
    status = await computeVpsComputerStatus(cfg, botId, runner);
  }
  return status;
}

async function withVpsLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
        acquireTimer = setTimeout(() => resolve(false), LOCK_ACQUIRE_TIMEOUT_MS);
        acquireTimer.unref?.();
      }),
    ]);
    if (acquireTimer) clearTimeout(acquireTimer);
    if (!acquired) {
      // Keep the queue serialized: this slot opens only when the holder's
      // does, so a later caller can never run beside the long operation the
      // timed-out one refused to wait for.
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
  const alias = vpsSshAlias(cfg);
  return alias ? `${alias}:${vpsContainerName(botId)}` : null;
}

/** Permanently remove one inventory row. The fresh inventory read happens
 * while holding the same per-container lock as provision/start/stop, so a
 * stale Settings tab can never delete a replacement container. */
export async function removeManagedVpsComputer(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  containerName: string,
  confirmName: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ removed: true; name: string }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) {
    throw Object.assign(new Error("VPS is not configured — add an SSH config alias in Connections"), { status: 409 });
  }
  if (!MANAGED_VPS_CONTAINER_NAME.test(containerName)) {
    throw Object.assign(new Error("invalid managed VPS computer name"), { status: 400 });
  }
  const key = `${alias}:${containerName}`;
  return withVpsLifecycleLock(key, async () => {
    const scan = await scanManagedVpsComputers(cfg, owners, runner);
    const inventory = scan.inventory;
    if (!inventory.available) {
      throw Object.assign(new Error(inventory.problem ?? "VPS computer inventory is unavailable"), { status: 503 });
    }
    const instance = inventory.instances.find((candidate) => candidate.name === containerName);
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
      // Use the immutable ID from the same inspect, not the mutable name. A
      // VPS administrator replacing a same-name container between inspect
      // and rm must not redirect this explicit removal to the replacement.
      await runner(vpsDockerArgs(alias, ["rm", "-f", containerId]), { timeoutMs: 2 * 60_000 });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 200);
      throw Object.assign(
        new Error(`The VPS refused to remove this computer${detail ? `: ${detail}` : ""}`),
        { status: 502 },
      );
    }
    statusCache.delete(key);
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
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in App Settings → Connections"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const operation = async () => {
    // A mutation invalidates every cached poll answer, before and after: the
    // panel must never keep showing the pre-action world for a TTL.
    statusCache.delete(key);
    try {
      const before = await computeVpsComputerStatus(cfg, botId, runner);
      if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? "Docker over SSH is not reachable"), { status: 409 });
      // A real lifecycle change invalidates the remote endpoint. Provision
      // is also the turn-start idempotency path, so leave an already-running
      // viewer alone when no start/replacement will occur.
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
        // remove exists to escape an incompatible or unsafe container (an
        // IMAGE_LAYER_VERSION bump otherwise bricks the bot: provision 409s
        // on assertUsableContainer forever), so it deliberately skips that
        // check. The ownership labels from the inspect are the only gate:
        // never docker-rm a container OpenMausBot did not create, even one
        // squatting on our name.
        if (before.container === "missing") return before;
        if (!before.managed) {
          throw Object.assign(
            new Error("The VPS container name is occupied by a container OpenMausBot did not create — remove it on the VPS yourself"),
            { status: 409 },
          );
        }
        await run(["rm", "-f", containerRef]);
        return computeVpsComputerStatus(cfg, botId, runner);
      } else {
        if (before.container !== "running") throw Object.assign(new Error("The VPS container is not running"), { status: 409 });
        assertUsableContainer(before);
        await run(["stop", containerRef]);
      }
      return action === "stop" ? computeVpsComputerStatus(cfg, botId, runner) : waitForVpsReady(cfg, botId, runner);
    } finally {
      statusCache.delete(key);
    }
  };
  return withVpsLifecycleLock(key, operation);
}

/** Auto is intentionally read-only: it can attach only to an existing ready
 * container. It recomputes rather than reading the poll cache — routing a
 * turn onto a container that stopped seconds ago is worse than one extra
 * inspection at turn start. */
export async function reuseVps(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus | null> {
  const status = await inspectVpsForAuto(cfg, botId, runner);
  return status.ready ? status : null;
}

/** Auto needs the complete fresh status to explain a failed attach, while
 * retaining reuseVps's no-cache/no-mutation routing guarantee. */
export async function inspectVpsForAuto(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const key = vpsLockKey(cfg, botId);
  return key
    ? withVpsLifecycleLock(key, () => computeVpsComputerStatus(cfg, botId, runner))
    : computeVpsComputerStatus(cfg, botId, runner);
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
  const child = spawn("ssh", vpsSshTunnelArgs(alias, localPort, connection.privateIp), {
    shell: false,
    env: { ...process.env, PATH: augmentedPath() },
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
  const alias = vpsSshAlias(cfg);
  if (!alias) throw new Error("VPS is not configured — add an SSH config alias first");
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.vpsContainerMcp, alias, containerRef ?? vpsContainerName(botId)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function vpsDriverError(driverKind: string, computerMcp: boolean): string | null {
  if (driverKind === "boxAgent") {
    return "The Computer engine runs its agent on Box and cannot use a self-hosted VPS — choose Claude or an ACP engine";
  }
  if (!computerMcp) {
    return "This model engine cannot mount a self-hosted VPS computer — choose Claude or an ACP engine";
  }
  return null;
}

export async function vpsComputerScreenshot(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ png: string; format: "png" | "jpeg" }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const cacheable = runner === defaultRunner;
  return withVpsLifecycleLock(key, async () => {
    // Same shape as containerComputerScreenshot's screenshotStatusCache: the
    // poller runs every few seconds, and re-verifying the whole container
    // between frames multiplied every frame's SSH cost.
    const cached = cacheable ? statusCache.get(key) : undefined;
    const status =
      cached && cached.expiresAt > Date.now()
        ? cached.status
        : await computeVpsComputerStatus(cfg, botId, runner);
    if (!status.ready) {
      if (cacheable) statusCache.delete(key);
      throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
    }
    if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    const containerRef = status.container_id ?? status.container_name;
    // The ref goes straight into docker argv, and a cached status is one
    // more step removed from the inspect that produced it — revalidate the
    // exact shapes before spending an exec on it.
    if (!CONTAINER_ID.test(containerRef) && !CONTAINER_NAME.test(containerRef)) {
      throw Object.assign(new Error("the VPS container reference is malformed"), { status: 409 });
    }
    try {
      await runner(
        vpsDockerArgs(
          alias,
          cuaExecArgs(
            ["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET, "--screenshot-out-file", SCREENSHOT_PATH],
            { container: containerRef },
          ),
        ),
        { timeoutMs: 30_000 },
      );
      const encoded = (await runner(vpsDockerArgs(alias, [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        containerRef,
        "base64",
        "-w0",
        SCREENSHOT_PATH,
      ]), { timeoutMs: 30_000 })).stdout.trim();
      const checked = wholeScreenshot(Buffer.from(encoded, "base64"));
      if (!checked.ok) throw Object.assign(new Error("Cua Driver returned an incomplete VPS screenshot"), { status: 502 });
      return { png: encoded, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
    } catch (error) {
      // The failure may mean the world changed (container stopped, link
      // dropped); a cached "ready" would keep the poller failing for a TTL.
      if (cacheable) statusCache.delete(key);
      throw error;
    } finally {
      await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerRef, "rm", "-f", SCREENSHOT_PATH]), {
        timeoutMs: 10_000,
      }).catch(() => {});
    }
  });
}
