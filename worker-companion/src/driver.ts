// Fixed-argv control of the local CUA Driver.
//
// Never a shell, and never an environment from the caller. The driver
// invocations here are constants; the one caller that supplies an executable,
// argv and cwd is task.ts, and every one of those values comes out of a staged
// manifest whose digest an operator approved. The companion's security value is
// that the wire itself cannot name a program to run.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { capabilityDigest, parkedCapability, writeActiveCapability } from "./capability.ts";
import { childEnvironment, cuaSocket, workerPlatform, type WorkerPlatform } from "./platform.ts";
import { asDigest, type Sha256Digest } from "./wire.ts";
import { expectedDriverDigests, matchesDriverDigests } from "./driver-digests.ts";

export const EXPECTED_DRIVER_VERSION = "0.20.0";
const MAX_CAPTURE_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 15_000;
export const MAC_WORKER_LAUNCH_AGENT_LABEL = "com.openmausbot.cua-worker";

export interface RunResult { stdout: string; stderr: string; code: number | null }

export interface RunOptions {
  /** Working directory for the child. Only ever a directory the caller has
   * already resolved inside an approved task root — never a path off the wire. */
  cwd?: string;
  /** Which platform's environment allow-list to build. Omitted on a real
   * worker, where the host's own platform is the answer; supplied by tests,
   * which run on Linux too and would otherwise trip `workerPlatform()`. */
  platform?: WorkerPlatform;
}

/** End the task's whole process tree before reporting a timeout. A detached
 * process group gives POSIX one exact kill target; Windows' built-in taskkill
 * `/T` provides the corresponding tree operation without invoking a shell. */
async function terminateProcessTree(
  child: ChildProcess,
  platform: WorkerPlatform,
  closed: Promise<void>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (child.pid === undefined) return;
  if (platform === "darwin") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        env: environment,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
      killer.once("close", () => resolve());
    });
  }
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
  ]);
}

export function runFixed(
  executable: string,
  args: string[],
  timeoutMs: number,
  acceptNonZero = false,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const platform = options.platform ?? workerPlatform();
    const environment = childEnvironment(platform);
    // Two calls rather than one with a conditional spread: an absent cwd is an
    // omission the reader can see, and the literal keeps its exact stdio tuple
    // type so `child.stdout` and `child.stderr` stay non-null below.
    const child = options.cwd === undefined
      ? spawn(executable, args, {
          shell: false,
          env: environment,
          windowsHide: true,
          detached: platform === "darwin",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(executable, args, {
          shell: false,
          env: environment,
          windowsHide: true,
          detached: platform === "darwin",
          stdio: ["ignore", "pipe", "pipe"],
          cwd: options.cwd,
        });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, platform, closed, environment)
        .finally(() => finish(() => reject(new Error(`${executable} timed out`))));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-MAX_CAPTURE_BYTES); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_CAPTURE_BYTES); });
    child.on("error", (error) => {
      if (!timedOut) finish(() => reject(new Error(`${executable} could not start: ${error.message}`)));
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish(() => {
        if (code === 0 || acceptNonZero) resolveResult({ stdout, stderr, code });
        else reject(new Error(stderr.trim().slice(-500) || `${executable} exited ${code ?? "without a status"}`));
      });
    });
  });
}

export type FixedRunner = typeof runFixed;

/** Restart the fixed interactive daemon after changing its immutable
 * capability manifest. Windows uses the official Scheduled Task; macOS uses
 * the dedicated LaunchAgent installed by docs/byo-macos.md. No label, socket,
 * executable, or arguments come from the wire. */
export async function restartWorkerDaemon(
  platform: WorkerPlatform = workerPlatform(),
  runner: FixedRunner = runFixed,
  uid: number | undefined = process.getuid?.(),
): Promise<void> {
  const socket = cuaSocket(platform);
  await runner("cua-driver", ["stop", "--socket", socket], READY_TIMEOUT_MS, true, { platform });
  if (platform === "win32") {
    await runner("cua-driver", ["autostart", "kick"], READY_TIMEOUT_MS, false, { platform });
    return;
  }
  if (uid === undefined) throw new Error("macOS worker launch requires a numeric user id");
  await runner(
    "launchctl",
    ["kickstart", "-k", `gui/${uid}/${MAC_WORKER_LAUNCH_AGENT_LABEL}`],
    READY_TIMEOUT_MS,
    false,
    { platform },
  );
}

/** The driver version is pinned, not floored. A newer driver may have different
 * tool semantics than the capability manifests were written against, and the
 * control plane refuses the worker anyway, so refuse it here with a message
 * that names the mismatch. */
export async function assertDriverVersion(platform?: WorkerPlatform): Promise<void> {
  const result = await runFixed("cua-driver", ["--version"], 10_000, false, { platform });
  const match = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/);
  if (match?.[1] !== EXPECTED_DRIVER_VERSION) {
    throw new Error(`CUA Driver ${match?.[1] ?? "missing"} does not match required ${EXPECTED_DRIVER_VERSION}`);
  }
}

export async function pauseWorker(): Promise<void> {
  const socket = cuaSocket();
  await runFixed("cua-driver", ["revoke", "--all", "--socket", socket], 10_000, true);
  await runFixed("cua-driver", ["stop", "--socket", socket], 10_000, true);
  const status = await runFixed("cua-driver", ["status", "--socket", socket], 5_000, true);
  if (status.code === 0) throw new Error("CUA Driver is still running after pause");
}

/** Bring the worker back up holding the non-action parked capability.
 *
 * The caller must name the base-policy digest it pinned. Requiring it here
 * means a resumed worker proves it is enforcing the same ceiling the control
 * plane recorded — a driver that silently loaded a different policy from disk
 * never satisfies the poll below. */
export async function resumeParkedWorker(expectedBasePolicySha256: Sha256Digest): Promise<Sha256Digest> {
  await assertDriverVersion();
  const content = parkedCapability();
  writeActiveCapability(content);
  const parkedDigest = asDigest(capabilityDigest(content));
  const socket = cuaSocket();
  const expected = expectedDriverDigests(parkedDigest, expectedBasePolicySha256, workerPlatform());
  await restartWorkerDaemon();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let diagnostic = "";
  while (Date.now() < deadline) {
    const status = await runFixed("cua-driver", ["status", "--socket", socket], 5_000, true);
    diagnostic = `${status.stdout}\n${status.stderr}`.toLowerCase();
    if (
      status.code === 0 &&
      matchesDriverDigests(diagnostic, expected)
    ) return parkedDigest;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`bounded CUA capability did not become active: ${diagnostic.trim().slice(-300) || "no status"}`);
}
