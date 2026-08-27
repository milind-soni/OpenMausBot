// Fixed-argv control of the local CUA Driver.
//
// Every invocation here is a constant: no shell, no caller-supplied executable,
// argv, cwd or environment. The companion's whole security value is that the
// wire cannot name a program to run.
import { spawn } from "node:child_process";

import { capabilityDigest, parkedCapability, writeActiveCapability } from "./capability.ts";
import { childEnvironment, cuaSocket } from "./platform.ts";
import { asDigest, type Sha256Digest } from "./wire.ts";

export const EXPECTED_DRIVER_VERSION = "0.20.0";
const MAX_CAPTURE_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 15_000;

export interface RunResult { stdout: string; stderr: string; code: number | null }

export function runFixed(
  executable: string,
  args: string[],
  timeoutMs: number,
  acceptNonZero = false,
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: childEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      finish(() => reject(new Error(`${executable} timed out`)));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-MAX_CAPTURE_BYTES); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_CAPTURE_BYTES); });
    child.on("error", (error) => finish(() => reject(new Error(`${executable} could not start: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code === 0 || acceptNonZero) resolveResult({ stdout, stderr, code });
      else reject(new Error(stderr.trim().slice(-500) || `${executable} exited ${code ?? "without a status"}`));
    }));
  });
}

/** The driver version is pinned, not floored. A newer driver may have different
 * tool semantics than the capability manifests were written against, and the
 * control plane refuses the worker anyway, so refuse it here with a message
 * that names the mismatch. */
export async function assertDriverVersion(): Promise<void> {
  const result = await runFixed("cua-driver", ["--version"], 10_000);
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

/** Bring the worker back up holding the deny-all parked capability.
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
  // Best effort: Windows runs the driver from a Scheduled Task that this kicks,
  // while a macOS guest may run it from a LaunchAgent that needs no kick. The
  // status poll below is the real gate either way.
  await runFixed("cua-driver", ["autostart", "kick"], READY_TIMEOUT_MS, true);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let diagnostic = "";
  while (Date.now() < deadline) {
    const status = await runFixed("cua-driver", ["status", "--socket", socket], 5_000, true);
    diagnostic = `${status.stdout}\n${status.stderr}`.toLowerCase();
    if (
      status.code === 0 &&
      diagnostic.includes(parkedDigest) &&
      diagnostic.includes(expectedBasePolicySha256.toLowerCase()) &&
      diagnostic.includes("bounded")
    ) return parkedDigest;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`bounded CUA capability did not become active: ${diagnostic.trim().slice(-300) || "no status"}`);
}
