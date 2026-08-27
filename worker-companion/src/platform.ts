// Per-OS locations and process environment for the worker companion.
//
// The two adapters in server/ pin these same paths from the control-plane
// side (`MAC_CUA_SOCKET_RELATIVE` and friends in server/mac-worker.ts,
// `WINDOWS_CUA_PIPE` and `WINDOWS_POLICY_PATH` in server/windows-worker.ts).
// They are duplicated rather than imported because the companion ships to the
// worker as a standalone package with no view of the server tree.
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkerPlatform = "darwin" | "win32";

export function workerPlatform(): WorkerPlatform {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  throw new Error(`unsupported worker platform: ${process.platform}`);
}

const localAppData = () => process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

/** The CUA control channel: a unix socket under the worker's own home on
 * macOS, the fixed named pipe on Windows. */
export function cuaSocket(platform: WorkerPlatform = workerPlatform()): string {
  return platform === "darwin"
    ? join(homedir(), ".openmausbot", "run", "cua.sock")
    : "\\\\.\\pipe\\cua-driver";
}

export function supportDirectory(platform: WorkerPlatform = workerPlatform()): string {
  return platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "OpenMausBot")
    : join(localAppData(), "OpenMausBot");
}

export function policyPath(platform: WorkerPlatform = workerPlatform()): string {
  return join(supportDirectory(platform), platform === "darwin" ? "macos-policy.yaml" : "windows-policy.yaml");
}

export function activeCapabilityPath(platform: WorkerPlatform = workerPlatform()): string {
  return join(supportDirectory(platform), "active-capabilities.yaml");
}

/** Fixed allow-list. Never inherit the caller's environment wholesale: the SSH
 * session's environment is attacker-adjacent and the driver is the one process
 * on this box that can drive the whole desktop. */
export function childEnvironment(platform: WorkerPlatform = workerPlatform()): NodeJS.ProcessEnv {
  const names = platform === "darwin"
    ? ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG"]
    : [
        "SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
      ];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
  );
}
