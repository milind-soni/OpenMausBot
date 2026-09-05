// Fixtures for the worker task layer, shared by the transport, approval,
// service and bridge tests so they cannot disagree about what a valid task
// looks like.
import { WORKER_DEFAULTS, type ResolvedWorker, type WorkerPlatform } from "../computer-workers.ts";
import type { JsonValue } from "../schema.ts";
import {
  parseWorkerTaskManifest,
  WORKER_TASK_IDLE_TIMEOUT_MS,
  WORKER_TASK_MANIFEST_VERSION,
  type WorkerTaskManifest,
} from "../worker-task-manifest.ts";

export const TASK_POLICY = "a".repeat(64);
export const TASK_PARKED_CAPABILITY = "b".repeat(64);
export const TASK_NOW = 1_800_000_000_000;

/** The platform whose path layout this host can actually produce. A macOS task
 * root is absolute-POSIX and a Windows one is drive-lettered, and the capability
 * builder refuses the wrong shape — so a test that touches real paths has to
 * follow the host it runs on. */
export const HOST_TASK_PLATFORM: WorkerPlatform = process.platform === "win32" ? "windows" : "macos";

/** A real, harmless executable that is absolute and not on either platform's
 * forbidden list. `node` would be rejected: it is a script host. */
export const HARMLESS_EXECUTABLE = process.platform === "win32"
  ? "C:\\Windows\\System32\\hostname.exe"
  : "/bin/echo";

/** Argv that makes the executable above exit 0. `hostname` with an argument
 * tries to SET the machine name and exits 1 without admin rights, so the two
 * platforms cannot share one argv. */
export const HARMLESS_ARGV = process.platform === "win32" ? [] : ["hello"];

export function workerFixture(
  platform: WorkerPlatform = HOST_TASK_PLATFORM,
  overrides: Partial<ResolvedWorker> = {},
): ResolvedWorker {
  const defaults = WORKER_DEFAULTS[platform];
  return {
    id: platform === "windows" ? "win-box" : "mac-guest",
    platform,
    displayName: platform === "windows" ? "Windows box" : "macOS guest",
    sshAlias: platform === "windows" ? "omb-win" : "omb-mac",
    expectedDriverVersion: "0.20.0",
    expectedBasePolicySha256: TASK_POLICY,
    expectedParkedCapabilitySha256: TASK_PARKED_CAPABILITY,
    browserExecutable: defaults.browserExecutable,
    browserProfile: defaults.browserProfile,
    ideExecutable: defaults.ideExecutable,
    paused: false,
    configured: true,
    ...overrides,
  };
}

/** A manifest document that parses, so each test changes exactly one thing. */
export function manifestFixture(
  platform: WorkerPlatform = HOST_TASK_PLATFORM,
  overrides: Record<string, JsonValue> = {},
): JsonValue {
  const worker = workerFixture(platform);
  const harmlessExecutable = platform === "windows"
    ? "C:\\Windows\\System32\\hostname.exe"
    : "/bin/echo";
  const harmlessArgv = platform === "windows" ? [] : ["hello"];
  return {
    version: WORKER_TASK_MANIFEST_VERSION,
    platform,
    workerId: worker.id,
    taskId: "task-1",
    threadId: "thread-1",
    createdAt: TASK_NOW,
    expiresAt: TASK_NOW + 60 * 60_000,
    idleTimeoutMs: WORKER_TASK_IDLE_TIMEOUT_MS,
    target: { sshAlias: worker.sshAlias, basePolicySha256: TASK_POLICY },
    files: [],
    commands: [{
      id: "build",
      executable: harmlessExecutable,
      argv: harmlessArgv,
      cwd: "src",
      timeoutMs: 60_000,
    }],
    origins: [],
    resultPaths: ["result.json", "changes.patch"],
    ...overrides,
  } as JsonValue;
}

/** The model-visible proposal. Identity, routing, policy and absolute time are
 * deliberately absent; WorkerTaskService binds those in the trusted process. */
export function taskProposalFixture(
  platform: WorkerPlatform = HOST_TASK_PLATFORM,
  overrides: Record<string, JsonValue> = {},
): JsonValue {
  const full = manifestFixture(platform) as Record<string, JsonValue>;
  return {
    version: full.version,
    taskId: full.taskId,
    files: full.files,
    commands: full.commands,
    origins: full.origins,
    resultPaths: full.resultPaths,
    ...overrides,
  } as JsonValue;
}

export function parsedManifest(
  platform: WorkerPlatform = HOST_TASK_PLATFORM,
  overrides: Record<string, JsonValue> = {},
  worker = workerFixture(platform),
  now = TASK_NOW,
): WorkerTaskManifest {
  return parseWorkerTaskManifest(manifestFixture(platform, overrides), worker, now);
}

/** The shape a companion task root has on each platform, for a fake that has to
 * report one back without a real worker. */
export function fakeTaskRoot(platform: WorkerPlatform, taskId: string): string {
  return platform === "windows"
    ? `C:\\Users\\worker\\AppData\\Local\\OpenMausBot\\tasks\\${taskId}`
    : `/Users/worker/Library/Application Support/OpenMausBot/tasks/${taskId}`;
}
