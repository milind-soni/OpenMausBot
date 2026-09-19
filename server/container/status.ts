// Local VM status: the authoritative ContainerComputerStatus computation,
// its problem ladder, image/ownership label checks, viewer password and URL
// derivation, the one cua-driver exec argv, the screenshot integrity check
// used by the readiness probe, and the loopback port predicates.

import {
  computerStatusProblem,
  probeCuaDesktop,
  type ComputerProblemLabels,
  type ComputerStatusCommon,
} from "../computer-backend.ts";
import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DISPLAY,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  SHARED_LOCAL_VM_TARGET,
  TARGET_LABEL,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
  type LocalVmTarget,
} from "./image.ts";
import {
  INTERNAL_VIEWER_PORT,
  MEMORY_BYTES,
  appleWorkspaceMountIsSafe,
  dockerSecurityIsHardened,
  dockerWorkspaceMountIsSafe,
  podmanSecurityIsHardened,
  type DockerHardeningConfig,
} from "./hardening.ts";
import { containerRuntimeStatus, sh, type CommandRunner, type Runtime } from "./runtime.ts";

export interface ContainerComputerStatus extends ComputerStatusCommon {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  network: "loopback" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  create_supported: boolean;
  target_key: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_port: number | null;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform, target: LocalVmTarget): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    create_supported: true,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_port: target.viewerPort,
    viewer_url: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

/** Whether a turn may recreate this Local VM itself instead of failing.
 *
 * True for exactly one state: the container is gone, and a plain `run` is all
 * that is needed to bring it back. That is what `LocalVmIdleTimer` leaves
 * behind — it removes an unused Local VM rather than pausing it — so a turn
 * arriving after an idle period should not have to send the person to App
 * Settings for a container the app itself deleted.
 *
 * Every other problem in `statusProblem` stays the person's call and returns
 * false here: no runtime, daemon down, image never prepared, `create_supported`
 * false, and any existing container — stale image, unmanaged, unsafe network,
 * security or persistence. A stopped container is excluded deliberately, since
 * `statusProblem` says this desktop image cannot safely resume and asks for a
 * recreate rather than a start.
 */
export function localVmRecreatableOnDemand(
  status: ContainerComputerStatus,
): status is ContainerComputerStatus & { runtime: Runtime } {
  return Boolean(status.runtime)
    && status.daemonUp
    && status.image
    && status.container === "missing"
    && status.create_supported;
}

/** Whether Auto may attach this Local VM without a person choosing it: the
 * desktop is ready, or its image is prepared and the container can simply be
 * recreated after idling away. Anything else — no runtime, daemon down, image
 * never prepared, an unmanaged or unsafe container — stays the person's call. */
export function autoLocalVmAttachable(status: ContainerComputerStatus): boolean {
  return status.ready === true || localVmRecreatableOnDemand(status);
}

/** The Local VM wording for the shared problem ladder (computer-backend.ts). */
const LOCAL_VM_PROBLEM_LABELS: ComputerProblemLabels = {
  runtimeMissing: "Install a supported container runtime first",
  daemonDown: (status) => `Start ${status.runtime} first`,
  imageMissing: `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`,
  createUnsupported: "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port",
  containerMissing: "Create the Local VM",
  imageMismatch: "The existing Local VM uses an older desktop or Cua Driver; recreate it",
  unmanaged: "The existing container was not created by OpenMausBot; recreate it",
  networkUnsafe: "The existing Local VM exposes its viewer publicly; recreate it",
  securityUnsafe: "The existing Local VM is missing safety limits; recreate it",
  persistenceUnsafe: "The existing Local VM is missing its durable workspace; recreate it",
  stopped: "This desktop image cannot safely resume; recreate the Local VM",
  desktopFailed: "The Local VM desktop failed to start",
  desktopNotReady: "The Local VM started, but Cua Driver is not ready yet",
};

function statusProblem(status: ContainerComputerStatus): string | null {
  return computerStatusProblem(status, LOCAL_VM_PROBLEM_LABELS);
}

/** Shared with the BYO-VPS backend (vps-computer.ts): both containers are
 * built from the same pinned derivative, so image compatibility is one rule. */
export function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    labels?.[IMAGE_LAYER_LABEL] === IMAGE_LAYER_VERSION
  );
}

/** Ownership is intentionally independent of the current image/driver
 * versions. An older OpenMausBot container must stay removable (and eligible
 * for idle cleanup), while imageMatches keeps readiness version-strict. */
function containerOwnershipLabelsMatch(
  labels: Record<string, string> | undefined,
  target: LocalVmTarget,
): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[WORKSPACE_LABEL] === "1" &&
    (target.key === SHARED_LOCAL_VM_TARGET.key
      ? labels?.[TARGET_LABEL] === undefined || labels?.[TARGET_LABEL] === target.label
      : labels?.[TARGET_LABEL] === target.label)
  );
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function inspectedImage(stdout: string): {
  labels: Record<string, string> | undefined;
  id: string | null;
} {
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
  }>;
  const image = parsed[0];
  return {
    labels:
      image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null, port: number | null): string {
  if (!port) return "";
  const base = `http://127.0.0.1:${port}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

/** The one authoritative `exec … cua-driver` argv. Shared with the BYO-VPS
 * backend and both MCP bridge entry points so the identity, env, and
 * telemetry knobs can never drift between the Local VM and a VPS container. */
export function cuaExecArgs(
  args: string[],
  options: { container?: string; interactive?: boolean } = {},
): string[] {
  return [
    "exec",
    ...(options.interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    options.container ?? CONTAINER,
    CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform, target);
  const runtimeStatus = await containerRuntimeStatus(runner, platform);
  status.available = runtimeStatus.available;
  status.runtime = runtimeStatus.runtime;
  status.daemonUp = runtimeStatus.daemonUp;
  status.create_supported = target.key === SHARED_LOCAL_VM_TARGET.key || status.runtime !== "container";
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    const { stdout } = await runner(status.runtime, ["image", "inspect", IMAGE]);
    const image = inspectedImage(stdout);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
    // The prepared OpenMausBot derivative has not been built yet.
  }

  try {
    const { stdout } = await runner(status.runtime, ["inspect", target.containerName]);
    if (status.runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      status.viewer_port = appleViewerPort(detail?.configuration?.publishedPorts, target.viewerPort);
      const appleImage =
        typeof detail?.configuration?.image === "string"
          ? detail.configuration.image
          : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId =
        typeof detail?.configuration?.image === "object"
          ? normalizeImageId(detail.configuration.image.descriptor?.digest)
          : null;
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerOwnershipLabelsMatch(detail?.configuration?.labels, target);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform, target.workspaceDir)
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      status.security =
        (resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === 2 ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.configuration?.environment), status.viewer_port);
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: DockerHardeningConfig & {
          PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        NetworkSettings?: {
          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        EffectiveCaps?: string[];
        BoundingCaps?: string[];
        State?: { Running?: boolean };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings) ? "loopback" : "unsafe";
      status.viewer_port = dockerViewerPort(detail?.NetworkSettings?.Ports, target.viewerPort);
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerOwnershipLabelsMatch(detail?.Config?.Labels, target);
      status.persistence = dockerWorkspaceMountIsSafe(
        detail?.Mounts,
        platform,
        target.workspaceDir,
        status.runtime,
      ) ? "durable" : "unsafe";
      status.security = (
        status.runtime === "podman"
          ? podmanSecurityIsHardened(detail?.HostConfig, detail?.EffectiveCaps, detail?.BoundingCaps)
          : dockerSecurityIsHardened(detail?.HostConfig)
      ) ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.Config?.Env), status.viewer_port);
    }
  } catch {
    // No container with this name.
  }

  const canProbe =
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    const runtime = status.runtime;
    const probed = await probeCuaDesktop({
      versionMismatchError: `expected cua-driver ${CUA_DRIVER_VERSION}`,
      version: () => runner(runtime, cuaExecArgs(["--version"], { container: target.containerName }), 8000),
      status: () => runner(runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: target.containerName }), 8000),
      healthReport: () =>
        runner(runtime, cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: target.containerName }), 15_000),
      // A local exec is free, so the readiness frame is pulled back and
      // pixel-validated here; over SSH that same validation would be a
      // full-frame base64 transfer on every status poll.
      desktopState: async () => {
        const readinessShot = "/tmp/openmausbot-readiness.png";
        await runner(
          runtime,
          cuaExecArgs([
            "call",
            "get_desktop_state",
            "{}",
            "--socket",
            CUA_SOCKET,
            "--screenshot-out-file",
            readinessShot,
          ], { container: target.containerName }),
          20_000,
        );
        const captured = await runner(
          runtime,
          ["exec", target.containerName, "base64", "-w0", readinessShot],
          20_000,
        );
        if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
          throw new Error("Cua Driver returned an incomplete readiness screenshot");
        }
      },
      // An empty log means XFCE and the supervisor-owned Cua daemon are
      // probably still starting. A real startup failure should be actionable
      // in the panel instead of looking like an endless readiness wait.
      errorLogTail: () =>
        runner(runtime, ["exec", target.containerName, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"], 4000),
    });
    status.desktopReady = probed.desktopReady;
    status.desktop_error = probed.desktop_error;
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function dockerViewerPort(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`]?.find((entry) => loopback(entry.HostIp))?.HostPort;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

function appleViewerPort(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.find(
    (binding) => binding.containerPort === INTERNAL_VIEWER_PORT && loopback(binding.hostAddress),
  )?.hostPort;
  return Number.isInteger(raw) && Number(raw) > 0 && Number(raw) <= 65_535 ? Number(raw) : fallback;
}

export type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

/** Shared with the BYO-VPS backend: a truncated base64 transfer must never
 * become a "successful" preview frame on either transport. */
export function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}
