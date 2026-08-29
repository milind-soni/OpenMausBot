// Shared transport and readiness contract for named remote CUA workers.
//
// Everything here is platform-neutral: the SSH invocation, the environment
// allow-list, the per-alias lease, and the fail-closed readiness ladder. Each
// platform adapter (./windows-worker.ts, ./mac-worker.ts) supplies only its
// own health probe and the checks that have no counterpart on the other OS.
import { spawn } from "node:child_process";

import { z } from "zod";

import {
  isValidWorkerSshAlias,
  type ResolvedWorker,
  type WorkerPlatform,
} from "./computer-workers.ts";
import { augmentedPath } from "./env-path.ts";
import type { JsonValue } from "./schema.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

export const WORKER_COMPANION_PROTOCOL_VERSION = 1;
export const WORKER_SSH_TIMEOUT_MS = 15_000;
const LEASE_TTL_MS = 30 * 60_000;

const SHA256 = /^[a-f0-9]{64}$/i;
/** Control characters and the shell metacharacters that would make a quoted
 * YAML scalar or an argv element ambiguous. */
const UNSAFE_PATH = /[\u0000-\u001f"|<>]/;

export type RemoteWorkerState =
  | "unconfigured"
  | "offline"
  | "wrong_driver_version"
  | "no_interactive_session"
  | "locked"
  | "policy_mismatch"
  | "ready"
  | "busy"
  | "paused";

export type RemoteWorkerErrorCode =
  | "worker_unconfigured"
  | "worker_offline"
  | "worker_driver_missing"
  | "worker_driver_wrong_version"
  | "worker_companion_missing"
  | "worker_privileged_account"
  | "worker_no_interactive_session"
  | "worker_channel_missing"
  | "worker_channel_access_denied"
  | "worker_locked"
  | "worker_policy_missing"
  | "worker_policy_mismatch"
  | "worker_permission_mode_mismatch"
  | "worker_capability_missing"
  | "worker_capability_mismatch"
  | "worker_accessibility_denied"
  | "worker_screen_recording_denied"
  | "worker_busy"
  | "worker_paused";

export interface RemoteWorkerLeaseRecord {
  sshAlias: string;
  threadId: string;
  botId: string;
  expiresAt: number;
}

/** One interactive desktop admits one task at a time: two concurrent turns
 * would interleave real mouse and keyboard input on the same screen. Leases
 * are keyed by SSH alias rather than by worker id, so distinct workers stay
 * fully independent and a Windows bot and a macOS bot hold their desktops at
 * the same time. `computer-workers.ts` rejects two ids sharing one alias,
 * which is what makes the key sound. */
export class RemoteWorkerLease {
  private readonly records = new Map<string, RemoteWorkerLeaseRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = LEASE_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("remote worker lease TTL must be positive");
    this.ttlMs = ttlMs;
  }

  current(sshAlias: string, isBotBusy: (botId: string) => boolean, now = Date.now()): RemoteWorkerLeaseRecord | null {
    const record = this.records.get(sshAlias);
    // A lease outlives neither its TTL nor its owner's turn. Dropping it when
    // the bot goes idle is what stops a crashed turn from parking a desktop
    // for the whole TTL.
    if (record && (record.expiresAt <= now || !isBotBusy(record.botId))) this.records.delete(sshAlias);
    const current = this.records.get(sshAlias);
    return current ? { ...current } : null;
  }

  claim(
    sshAlias: string,
    threadId: string,
    botId: string,
    isBotBusy: (botId: string) => boolean,
    now = Date.now(),
  ): boolean {
    if (!isValidWorkerSshAlias(sshAlias)) return false;
    const current = this.current(sshAlias, isBotBusy, now);
    if (current && current.threadId !== threadId) return false;
    this.records.set(sshAlias, { sshAlias, threadId, botId, expiresAt: now + this.ttlMs });
    return true;
  }

  touch(threadId: string, now = Date.now()): void {
    for (const [alias, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(alias);
      else if (record.threadId === threadId) record.expiresAt = now + this.ttlMs;
    }
  }

  release(threadId: string): void {
    for (const [alias, record] of this.records) {
      if (record.threadId === threadId) this.records.delete(alias);
    }
  }

  /** Releases every lease on one alias regardless of owner. Used when a worker
   * is removed or repointed, so a stale record cannot keep reporting `busy`
   * for a machine the control plane no longer addresses. */
  releaseAlias(sshAlias: string): void {
    this.records.delete(sshAlias);
  }
}

/** The exact JSON a platform health probe returns, parsed at its I/O
 * boundary. This payload crosses a trust edge — it is whatever a remote
 * machine's shell printed — so every field is validated here rather than
 * narrowed at each use.
 *
 * Each field carries `.catch(undefined)` so one malformed value degrades to
 * "not proven" instead of discarding the whole report. That matters: a probe
 * from a half-configured worker is exactly the case the operator needs
 * diagnostics for, and a report that failed to parse wholesale would surface
 * as a bare offline error naming nothing. */
const healthReportSchema = z.object({
  driverVersion: z.string().max(64).nullish().catch(undefined),
  companionVersion: z.number().int().nullish().catch(undefined),
  /** True when the SSH account can administer the machine. A worker account
   * with admin rights can rewrite the very policy that bounds it. */
  privileged: z.boolean().optional().catch(undefined),
  interactiveSession: z.boolean().optional().catch(undefined),
  interactiveSessionId: z.number().int().positive().nullish().catch(undefined),
  locked: z.boolean().optional().catch(undefined),
  channelPath: z.string().min(1).max(512)
    .refine((value) => !UNSAFE_PATH.test(value))
    .nullish().catch(undefined),
  channelAvailable: z.boolean().optional().catch(undefined),
  channelAccess: z.enum(["ok", "missing", "denied", "unknown"]).optional().catch(undefined),
  policyDigest: z.string().regex(SHA256).transform((value) => value.toLowerCase()).nullish().catch(undefined),
  policyLoaded: z.boolean().optional().catch(undefined),
  permissionMode: z.enum(["bounded", "standard", "unrestricted", "unknown"]).optional().catch(undefined),
  capabilityDigest: z.string().regex(SHA256).transform((value) => value.toLowerCase()).nullish().catch(undefined),
  capabilityLoaded: z.boolean().optional().catch(undefined),
  /** macOS only. Windows has no TCC analogue and leaves these undefined,
   * which the macOS ladder treats as denied. */
  accessibilityGranted: z.boolean().optional().catch(undefined),
  screenRecordingGranted: z.boolean().optional().catch(undefined),
}).loose();

export type RemoteWorkerHealthReport = z.output<typeof healthReportSchema>;

/** Never throws: every field catches, so an unparseable payload yields a
 * report in which nothing is proven. */
export function parseHealthReport(raw: JsonValue): RemoteWorkerHealthReport {
  const parsed = healthReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export interface RemoteWorkerStatus {
  workerId: string;
  platform: WorkerPlatform;
  displayName: string;
  configured: boolean;
  state: RemoteWorkerState;
  ready: boolean;
  paused: boolean;
  expectedDriverVersion: string;
  driverVersion: string | null;
  companionVersion: number | null;
  privileged: boolean;
  interactiveSession: boolean;
  interactiveSessionId: number | null;
  locked: boolean;
  channelPath: string | null;
  channelAvailable: boolean;
  channelAccess: "ok" | "missing" | "denied" | "unknown";
  policyDigest: string | null;
  /** True only when the driver reports the same digest as the on-disk policy.
   * A matching file is not enough: the driver loads policy once at daemon
   * start, and an unset policy variable disables enforcement entirely. */
  policyLoaded: boolean;
  expectedPolicyDigest: string | null;
  policyMatches: boolean;
  permissionMode: "bounded" | "standard" | "unrestricted" | "unknown";
  capabilityDigest: string | null;
  capabilityLoaded: boolean;
  accessibilityGranted: boolean | null;
  screenRecordingGranted: boolean | null;
  lease: { botId: string; threadId: string; expiresAt: number } | null;
  errorCode: RemoteWorkerErrorCode | null;
  problem: string | null;
}

export type RemoteWorkerSshRunner = (
  args: string[],
  timeoutMs?: number,
  stdin?: string,
) => Promise<{ stdout: string; stderr: string }>;

export function remoteWorkerSshBaseArgs(sshAlias: string): string[] {
  if (!isValidWorkerSshAlias(sshAlias)) throw new Error("invalid worker SSH config alias");
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", sshAlias];
}

/** SSH needs the operator's home directory, agent socket, locale and PATH,
 * but it never needs API keys or OpenMausBot's loopback control token. Build
 * an allow-list rather than trying to enumerate every possible secret. */
export function remoteWorkerSshEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  for (const name of ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function defaultRemoteWorkerRunner(
  args: string[],
  timeoutMs = WORKER_SSH_TIMEOUT_MS,
  stdin = "",
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      shell: false,
      env: remoteWorkerSshEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("worker SSH health check timed out")));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {
      // A fast remote failure may close stdin before Node finishes writing.
      // The child close/error path below remains the authoritative result.
    });
    child.stdin.end(stdin);
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.on("error", (error) => finish(() => reject(new Error(`worker SSH could not start: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().slice(-500) || `worker SSH exited ${code ?? "without a status"}`));
    }));
  });
}

export function isSafeChannelPath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !UNSAFE_PATH.test(value);
}

export function baseWorkerStatus(worker: ResolvedWorker): RemoteWorkerStatus {
  return {
    workerId: worker.id,
    platform: worker.platform,
    displayName: worker.displayName,
    configured: worker.configured,
    state: "unconfigured",
    ready: false,
    paused: worker.paused,
    expectedDriverVersion: worker.expectedDriverVersion,
    driverVersion: null,
    companionVersion: null,
    privileged: false,
    interactiveSession: false,
    interactiveSessionId: null,
    locked: false,
    channelPath: null,
    channelAvailable: false,
    channelAccess: "unknown",
    policyDigest: null,
    policyLoaded: false,
    expectedPolicyDigest: worker.expectedBasePolicySha256,
    policyMatches: false,
    permissionMode: "unknown",
    capabilityDigest: null,
    capabilityLoaded: false,
    accessibilityGranted: null,
    screenRecordingGranted: null,
    lease: null,
    errorCode: "worker_unconfigured",
    problem: "Configure this worker's SSH alias and expected base-policy SHA-256",
  };
}

export function failWorker(
  status: RemoteWorkerStatus,
  state: RemoteWorkerState,
  code: RemoteWorkerErrorCode,
  problem: string,
): RemoteWorkerStatus {
  status.state = state;
  status.errorCode = code;
  status.problem = problem;
  return status;
}

/** Copies a probe result onto the status without deciding readiness. Split
 * from the ladder below so a caller can render a diagnostic panel for a
 * worker that will never become ready. */
export function applyHealthReport(status: RemoteWorkerStatus, raw: JsonValue): RemoteWorkerStatus {
  const report = parseHealthReport(raw);
  status.driverVersion = report.driverVersion ?? null;
  status.companionVersion = report.companionVersion ?? null;
  status.privileged = report.privileged === true;
  status.interactiveSessionId = report.interactiveSessionId ?? null;
  // A session flag without an id is not a proven session.
  status.interactiveSession = report.interactiveSession === true && status.interactiveSessionId !== null;
  status.locked = report.locked === true;
  status.channelPath = report.channelPath ?? null;
  status.channelAvailable = report.channelAvailable === true;
  status.channelAccess = report.channelAccess ?? "unknown";
  status.policyDigest = report.policyDigest ?? null;
  status.policyLoaded = report.policyLoaded === true;
  status.policyMatches = status.policyLoaded
    && status.policyDigest !== null
    && status.policyDigest === status.expectedPolicyDigest;
  status.permissionMode = report.permissionMode ?? "unknown";
  status.capabilityDigest = report.capabilityDigest ?? null;
  status.capabilityLoaded = report.capabilityLoaded === true;
  status.accessibilityGranted = report.accessibilityGranted ?? null;
  status.screenRecordingGranted = report.screenRecordingGranted ?? null;
  return status;
}

/** The readiness ladder every platform shares, ordered so the operator sees
 * the most actionable failure first. Returns a failed status, or null when
 * every shared check passed and the adapter should run its own. */
export function evaluateSharedHealth(status: RemoteWorkerStatus): RemoteWorkerStatus | null {
  if (!status.driverVersion) {
    return failWorker(status, "wrong_driver_version", "worker_driver_missing",
      "CUA Driver is not installed or not on PATH for the worker's SSH user");
  }
  if (status.driverVersion !== status.expectedDriverVersion) {
    return failWorker(status, "wrong_driver_version", "worker_driver_wrong_version",
      `Worker CUA Driver ${status.driverVersion} does not match required ${status.expectedDriverVersion}`);
  }
  if (status.companionVersion !== WORKER_COMPANION_PROTOCOL_VERSION) {
    return failWorker(status, "wrong_driver_version", "worker_companion_missing",
      `Worker companion protocol ${WORKER_COMPANION_PROTOCOL_VERSION} is not installed`);
  }
  if (status.privileged) {
    return failWorker(status, "policy_mismatch", "worker_privileged_account",
      "The worker's SSH account must be a dedicated non-administrator user");
  }
  if (!status.interactiveSession) {
    return failWorker(status, "no_interactive_session", "worker_no_interactive_session",
      "No interactive desktop session is running on the worker");
  }
  if (status.locked) return failWorker(status, "locked", "worker_locked", "The worker's desktop is locked");
  if (status.channelAccess === "denied") {
    return failWorker(status, "no_interactive_session", "worker_channel_access_denied",
      "The worker's SSH user cannot reach the interactive CUA control channel");
  }
  if (!status.channelAvailable || !status.channelPath) {
    return failWorker(status, "no_interactive_session", "worker_channel_missing",
      "The interactive CUA control channel is not available on the worker");
  }
  if (!status.policyDigest) {
    return failWorker(status, "policy_mismatch", "worker_policy_missing", "The worker's base policy is missing");
  }
  if (!status.policyLoaded) {
    return failWorker(status, "policy_mismatch", "worker_policy_mismatch",
      "CUA Driver did not report the configured base policy as loaded");
  }
  if (!status.policyMatches) {
    return failWorker(status, "policy_mismatch", "worker_policy_mismatch",
      "The worker's base-policy digest does not match the approved configuration");
  }
  if (status.permissionMode !== "bounded") {
    return failWorker(status, "policy_mismatch", "worker_permission_mode_mismatch",
      "CUA Driver must run in bounded permission mode");
  }
  if (!status.capabilityDigest) {
    return failWorker(status, "policy_mismatch", "worker_capability_missing",
      "The active CUA capability manifest is missing on the worker");
  }
  if (!status.capabilityLoaded) {
    return failWorker(status, "policy_mismatch", "worker_capability_mismatch",
      "CUA Driver did not report the active capability manifest as loaded");
  }
  return null;
}

/** Applies the lease last, so `busy` never masks a configuration fault the
 * operator still has to fix. */
export function finishWorkerStatus(
  status: RemoteWorkerStatus,
  sshAlias: string,
  options: { lease?: RemoteWorkerLease; isBotBusy?: (botId: string) => boolean },
): RemoteWorkerStatus {
  const lease = options.lease?.current(sshAlias, options.isBotBusy ?? (() => true)) ?? null;
  status.lease = lease ? { botId: lease.botId, threadId: lease.threadId, expiresAt: lease.expiresAt } : null;
  if (lease) return failWorker(status, "busy", "worker_busy", "This desktop is leased by another active task");
  status.state = "ready";
  status.ready = true;
  status.errorCode = null;
  status.problem = null;
  return status;
}

export function remoteWorkerCuaMcpSshArgs(sshAlias: string, channelPath: string): string[] {
  if (!isSafeChannelPath(channelPath)) throw new Error("invalid worker CUA control channel path");
  return [...remoteWorkerSshBaseArgs(sshAlias), "cua-driver", "mcp", "--socket", channelPath];
}

/** The generation string pins every fact the connection depends on. Any drift
 * — a driver upgrade, a re-approved policy, a new capability manifest, a moved
 * control channel — produces a different generation and forces a reconnect
 * rather than silently reusing a bridge bound to the old guarantees. */
export interface RemoteWorkerMcpDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The integration contract speaks Node's platform names. The worker's own
   * spelling travels in argv instead, where the bridge needs it to pick a
   * liveness command. */
  platform: "darwin" | "win32";
  generation: string;
  scope: "remote-worker-computer";
}

/** The bridge process's own environment: the two loopback endpoints, and
 * nothing else. Built in statements rather than conditional spreads so an
 * absent endpoint is visibly an omission rather than an empty object folded
 * into a literal. */
function bridgeEnvironment(
  control?: { url: string; token: string },
  task?: { url: string; token: string },
) {
  const env: Record<string, string> = {};
  if (control) {
    env.OMB_CONTROL_URL = control.url;
    env.OMB_CONTROL_TOKEN = control.token;
  }
  if (task) {
    env.OMB_TASK_URL = task.url;
    env.OMB_TASK_TOKEN = task.token;
  }
  return env;
}

export function remoteWorkerMcp(
  worker: ResolvedWorker,
  channelPath: string,
  control?: { url: string; token: string },
  capabilityDigest?: string,
  task?: { url: string; token: string },
): RemoteWorkerMcpDescriptor {
  if (!worker.sshAlias) throw new Error("worker SSH alias is not configured");
  // Throws before any bridge is spawned when the channel path is unsafe.
  remoteWorkerCuaMcpSshArgs(worker.sshAlias, channelPath);
  return {
    command: SPAWNED_PROXIES.workerMcp,
    args: [worker.sshAlias, channelPath, worker.platform],
    // Both loopback endpoints reach only the bridge process. The ssh child it
    // spawns gets `remoteWorkerSshEnvironment()` instead, which carries neither
    // of these, so nothing here can travel to the worker.
    env: bridgeEnvironment(control, task),
    platform: worker.platform === "windows" ? "win32" : "darwin",
    generation: [
      worker.expectedDriverVersion,
      worker.expectedBasePolicySha256 ?? "no-policy",
      capabilityDigest ?? "parked",
      channelPath,
    ].join(":"),
    scope: "remote-worker-computer",
  };
}
