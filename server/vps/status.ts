// Status types, problem predicates, the uncached container inspection, and
// the poll/screenshot/viewer caches shared with the lifecycle and tunnel
// modules.

import {
  BASE_IMAGE,
  CUA_DRIVER_VERSION,
  IMAGE as CUA_IMAGE,
  CUA_SOCKET,
  cuaExecArgs,
  dockerSecurityIsHardened,
  imageLabelsMatch,
  type DockerHardeningConfig,
} from "../container-computer.ts";
import {
  computerStatusProblem,
  probeCuaDesktop,
  type ComputerProblemLabels,
  type ComputerStatusCommon,
} from "../computer-backend.ts";
import { vpsSshAlias, type AppConfig } from "../config.ts";
import {
  CONTAINER_ID,
  IMAGE_ID,
  VPS_CONTAINER_LABEL,
  VPS_ENVIRONMENT_LABEL,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  VIEWER_VERSION,
  defaultRunner,
  snapshotVpsConfig,
  vpsContainerName,
  vpsDockerArgs,
  vpsEnvironmentId,
  vpsLockKey,
  type VpsCommandRunner,
} from "./cli.ts";

// The panel polls status every 4-6s and the screen poller re-checks it before
// every frame; each full status is several docker-over-SSH processes. Same
// pattern as container-computer's screenshotStatusCache, and the same TTL.
export const STATUS_CACHE_TTL_MS = 10_000;

export const statusCache = new Map<string, { status: VpsComputerStatus; expiresAt: number }>();

export type VpsScreenshot = { png: string; format: "png" | "jpeg" };

export const pendingScreenshots = new Map<string, Promise<VpsScreenshot>>();

export const viewerConnections = new Map<string, { privateIp: string; password: string }>();

export interface VpsComputerStatus extends ComputerStatusCommon {
  configured: boolean;
  sshAlias: string | null;
  network: "private" | "unsafe" | "unknown";
  mounts: "none" | "unsafe" | "unknown";
  container_id: string | null;
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
    image_ref: CUA_IMAGE,
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

export function privateDockerIpv4(value: string | undefined): boolean {
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

/** The VPS wording for the shared problem ladder (computer-backend.ts).
 * Built lazily: the module graph is cyclic and the labels interpolate a
 * container-computer constant. */
function vpsProblemLabels(): ComputerProblemLabels {
  return {
    unconfigured: "Configure a VPS SSH alias in App Settings → Connections",
    daemonDown: "Docker over SSH could not reach the VPS; check the SSH alias and Docker on the VPS",
    imageMissing: `Prepare the pinned OpenMausBot Cua image on the VPS (Driver ${CUA_DRIVER_VERSION})`,
    containerMissing: "No OpenMausBot container exists for this bot on the VPS",
    imageMismatch: "The VPS container uses an incompatible or untrusted OpenMausBot image",
    unmanaged: "The VPS container name is occupied by a container OpenMausBot did not create",
    networkUnsafe: "The VPS container uses an unapproved network or publishes ports; refusing to use it",
    mountsUnsafe: "The VPS container has host mounts; refusing to use it",
    securityUnsafe: "The VPS container is missing OpenMausBot safety limits",
    stopped: "The OpenMausBot VPS container is stopped",
    desktopFailed: "The VPS Cua desktop failed to start",
    desktopNotReady: "The VPS container started, but Cua Driver is not ready yet",
  };
}

function statusProblem(status: VpsComputerStatus): string | null {
  return computerStatusProblem(status, vpsProblemLabels());
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
export async function computeVpsComputerStatus(
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
    const inspected = JSON.parse((await run(["image", "inspect", CUA_IMAGE])).stdout) as Array<{
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
      (detail?.Config?.Image === CUA_IMAGE || detail?.Config?.Image === inspectedImageId) &&
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
      // The desktop must ANSWER, not render: get_desktop_state succeeding
      // is the readiness proof. The Local VM also pulls a pixel-validated
      // readiness screenshot because a local exec is free; over SSH that is
      // a full-frame base64 transfer on every status poll, so pixel
      // validation lives solely in vpsComputerScreenshot().
      const probed = await probeCuaDesktop({
        versionMismatchError: "unexpected Cua Driver version",
        version: () => run(cuaExecArgs(["--version"], { container: containerRef })),
        status: () => run(cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: containerRef })),
        healthReport: () =>
          run(cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: containerRef }), 15_000),
        desktopState: () =>
          run(cuaExecArgs(["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET], { container: containerRef }), 20_000),
        errorLogTail: () =>
          run(["exec", containerRef, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"], 10_000),
      });
      status.desktopReady = probed.desktopReady;
      status.desktop_error = probed.desktop_error;
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
    // A capture already checks this exact target. Let it finish instead of
    // opening another six SSH connections while its readiness check is cold.
    await pendingScreenshots.get(key)?.catch(() => {});
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
  }
  const status = await computeVpsComputerStatus(cfg, botId, runner);
  if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return status;
}
