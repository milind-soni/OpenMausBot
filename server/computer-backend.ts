// One dispatch surface for the three managed computer backends — BYO VPS,
// Local VM, and Box. Callers resolve the backend once with
// computerBackendFor(bot) instead of scattering `cloudBackend === "vps"`
// ternaries; the provider modules keep their existing functions and expose
// thin backend objects satisfying the variant interfaces below.
import { CUA_DRIVER_VERSION } from "./container-computer.ts";
import { vpsComputerBackend } from "./vps-computer.ts";
import { boxComputerBackend } from "./box.ts";
import type { AppConfig } from "./config.ts";
import type {
  CommandRunner,
  ContainerComputerStatus,
  LifecycleAction,
  LocalVmTarget,
  Runtime,
} from "./container-computer.ts";
import type {
  BoxComputerStatus,
  ManagedBoxInventory,
  ManagedBoxMutationClaim,
  ManagedBoxOwner,
} from "./box.ts";
import type {
  ManagedVpsInventory,
  ManagedVpsOwner,
  VpsComputerStatus,
  VpsLifecycleAction,
} from "./vps-computer.ts";

/** Status fields the two container-style backends report identically. The
 * VPS and Local VM payloads extend this; Box reports its own hosted shape. */
export interface ComputerStatusCommon {
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "private" | "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
}

/** A status as the problem ladder reads it: the common fields plus the
 * optional per-backend preconditions individual rungs consult. */
export interface ComputerProblemStatus extends ComputerStatusCommon {
  configured?: boolean;
  runtime?: string | null;
  create_supported?: boolean;
  mounts?: "none" | "unsafe" | "unknown";
  persistence?: "durable" | "unsafe" | "unknown";
}

/** Per-backend wording for the shared problem ladder. Wordings have
 * deliberately drifted between the VPS and Local VM, so every rung's string
 * stays with its backend; optional rungs (unconfigured, mounts,
 * persistence, …) only fire for a backend that supplies them. */
export interface ComputerProblemLabels {
  unconfigured?: string;
  runtimeMissing?: string;
  daemonDown: string | ((status: ComputerProblemStatus) => string);
  imageMissing: string;
  createUnsupported?: string;
  containerMissing: string;
  imageMismatch: string;
  unmanaged: string;
  networkUnsafe: string;
  mountsUnsafe?: string;
  securityUnsafe: string;
  persistenceUnsafe?: string;
  stopped: string;
  desktopFailed: string;
  desktopNotReady: string;
}

/** The one readiness-problem ladder shared by the VPS and Local VM status
 * computations, preserving the rung order both modules used independently. */
export function computerStatusProblem(
  status: ComputerProblemStatus,
  labels: ComputerProblemLabels,
): string | null {
  if (labels.unconfigured !== undefined && status.configured === false) return labels.unconfigured;
  if (labels.runtimeMissing !== undefined && !status.runtime) return labels.runtimeMissing;
  if (!status.daemonUp) {
    return typeof labels.daemonDown === "function" ? labels.daemonDown(status) : labels.daemonDown;
  }
  if (!status.image) return labels.imageMissing;
  if (labels.createUnsupported !== undefined && status.container === "missing" && status.create_supported === false) {
    return labels.createUnsupported;
  }
  if (status.container === "missing") return labels.containerMissing;
  if (!status.imageMatches) return labels.imageMismatch;
  if (!status.managed) return labels.unmanaged;
  if (status.network === "unsafe") return labels.networkUnsafe;
  if (labels.mountsUnsafe !== undefined && status.mounts === "unsafe") return labels.mountsUnsafe;
  if (status.security === "unsafe") return labels.securityUnsafe;
  if (labels.persistenceUnsafe !== undefined && status.persistence === "unsafe") return labels.persistenceUnsafe;
  if (status.container === "stopped") return labels.stopped;
  if (status.desktop_error) return `${labels.desktopFailed}: ${status.desktop_error}`;
  if (!status.desktopReady) return labels.desktopNotReady;
  return null;
}

/** One CUA readiness probe behind both container backends: version →
 * health_report → get_desktop_state, with the supervisor error-log tail on
 * failure. The caller supplies runner closures so the local exec and the
 * docker-over-SSH transports keep their own argv, timeouts, and — for the
 * Local VM only — pixel validation of the readiness frame. */
export interface CuaDesktopProbe {
  /** Thrown when `--version` does not match the pinned driver; the two
   * backends word this differently and the wording is user-visible. */
  versionMismatchError: string;
  version(): Promise<{ stdout: string }>;
  status(): Promise<{ stdout: string }>;
  healthReport(): Promise<{ stdout: string }>;
  /** Prove the desktop answers; the Local VM also validates a frame here. */
  desktopState(): Promise<unknown>;
  errorLogTail(): Promise<{ stdout: string }>;
}

export interface CuaDesktopProbeResult {
  desktopReady: boolean;
  desktop_error: string | null;
}

export async function probeCuaDesktop(probe: CuaDesktopProbe): Promise<CuaDesktopProbeResult> {
  try {
    if ((await probe.version()).stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) {
      throw new Error(probe.versionMismatchError);
    }
    await probe.status();
    const health = await probe.healthReport();
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
    await probe.desktopState();
    return { desktopReady: true, desktop_error: null };
  } catch (error) {
    let desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
    try {
      // When the desktop fails, the supervisor's error log says WHY — a
      // bounded tail turns an endless "not ready yet" into something the
      // user can act on.
      const errorLog = await probe.errorLogTail();
      const logTail = errorLog.stdout.replace(/\s+/g, " ").trim();
      if (logTail) {
        desktop_error = [desktop_error, logTail].filter(Boolean).join(": ").slice(0, 320);
      }
    } catch {
      // The log may not exist during the first seconds of container boot.
    }
    return { desktopReady: false, desktop_error };
  }
}

export type ComputerBackendKind = "vps" | "container" | "box";

/** A frame off a managed desktop, as the panel and chat viewer consume it. */
export interface ComputerScreenshotFrame {
  png: string;
  format: "png" | "jpeg";
}

/** Spawn contract handed to agent runtimes for a computer MCP bridge. */
export interface ComputerMcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Extra inputs the Box action verbs need (provision names the bot, exec
 * carries the panel console command). */
export interface BoxActionInput {
  botName?: string;
  command?: string;
}

export interface VpsComputerBackend {
  readonly kind: "vps";
  status(cfg: AppConfig, botId: string): Promise<VpsComputerStatus>;
  action(cfg: AppConfig, botId: string, action: VpsLifecycleAction): Promise<VpsComputerStatus>;
  screenshot(cfg: AppConfig, botId: string): Promise<ComputerScreenshotFrame>;
  join(cfg: AppConfig, botId: string): Promise<{ joinUrl: string; state: "running" }>;
  closeViewer(botId: string): { closed: boolean };
  inventory(cfg: AppConfig, owners: ManagedVpsOwner[]): Promise<ManagedVpsInventory>;
  removeManaged(
    cfg: AppConfig,
    owners: ManagedVpsOwner[],
    containerName: string,
    confirmName: string,
  ): Promise<{ removed: true; name: string }>;
  mcp(cfg: AppConfig, botId: string, containerRef?: string): ComputerMcpLaunch;
  /** Auto's read-only reuse check: full fresh status without mutation. */
  inspectForAuto(cfg: AppConfig, botId: string): Promise<VpsComputerStatus>;
}

export interface BoxComputerBackend {
  readonly kind: "box";
  status(cfg: AppConfig, botId: string): Promise<BoxComputerStatus>;
  action(
    cfg: AppConfig,
    botId: string,
    action: "provision" | "sleep" | "exec",
    input?: BoxActionInput,
  ): Promise<unknown>;
  screenshot(cfg: AppConfig, botId: string, knownBoxId?: string): Promise<ComputerScreenshotFrame>;
  join(cfg: AppConfig, botId: string, mode: "ready" | "wake"): Promise<{ joinUrl: string; state: string | null }>;
  closeViewer(botId?: string): { closed: false };
  inventory(
    cfg: AppConfig,
    owners: ManagedBoxOwner[],
    options?: { adoptLegacy?: boolean },
  ): Promise<ManagedBoxInventory>;
  removeManaged(
    cfg: AppConfig,
    owners: ManagedBoxOwner[],
    boxId: string,
    confirmName: string,
    claim?: ManagedBoxMutationClaim,
    options?: { pollDelaysMs?: readonly number[] },
  ): Promise<{ ok: boolean; pending?: true }>;
}

export interface ContainerComputerBackend {
  readonly kind: "container";
  status(
    runner?: CommandRunner,
    platform?: NodeJS.Platform,
    target?: LocalVmTarget,
  ): Promise<ContainerComputerStatus>;
  action(
    action: LifecycleAction,
    runner?: CommandRunner,
    platform?: NodeJS.Platform,
    target?: LocalVmTarget,
  ): Promise<ContainerComputerStatus>;
  screenshot(runner?: CommandRunner, platform?: NodeJS.Platform, target?: LocalVmTarget): Promise<string>;
  mcp(
    runtime: Runtime,
    control?: { url: string; token: string },
    target?: LocalVmTarget,
  ): ComputerMcpLaunch;
}

export type CloudComputerBackend = VpsComputerBackend | BoxComputerBackend;
export type ComputerBackend = CloudComputerBackend | ContainerComputerBackend;

/** The single place a bot's configured cloud backend becomes an object. */
export function computerBackendFor(bot: { cloudBackend?: "vps" | "box" }): CloudComputerBackend {
  return bot.cloudBackend === "vps" ? vpsComputerBackend : boxComputerBackend;
}
