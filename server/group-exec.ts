// A child started in a process group of its own (POSIX), so a timeout or a stop reaches what it started too: git's remote
// helpers, docker's CLI plugins, ffmpeg's workers, ssh's ProxyCommand. Signalling the child alone orphans them. Windows has
// no process groups: taskkill /T walks the tree there.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Spawn options: a group of its own on POSIX; no console window on Windows. */
export const OWN_GROUP = { windowsHide: true, detached: process.platform !== "win32" } as const;

const KILL_GRACE_MS = 2_000;

function groupSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch { return false; }
}

/** SIGTERM to the child's group now and SIGKILL to what is left of it after `graceMs`. Only while the child has not been
 * seen to exit, or within the grace: a group outlives its leader only while a member runs, and the system gives no new
 * process that number while it does. */
export function stopGroup(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  const pid = child.pid;
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return;
  if (pid && process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  // No pid (it never started) or no group of its own: the child alone.
  if (!pid || !groupSignal(pid, "SIGTERM")) {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  const hard = setTimeout(() => groupSignal(pid, "SIGKILL"), graceMs);
  hard.unref?.();
}

type ExecError = Error & { code?: number | string | null; signal?: NodeJS.Signals | null; killed?: boolean; cmd?: string; stdout?: string; stderr?: string };
type GroupExecOptions = Pick<SpawnOptions, "cwd" | "env" | "uid" | "gid"> & { timeout?: number; maxBuffer?: number; signal?: AbortSignal; encoding?: "utf8"; input?: never };

/** execFile in a group of its own (execFile itself drops `detached`): `timeout` and `signal` stop the whole group (SIGTERM,
 * then SIGKILL), and its errors are shaped as execFile's: `code` is the exit code (or the spawn error's), `killed` is true
 * for a run it stopped, and output past `maxBuffer` (1 MiB) stops it. Output is UTF-8 text. */
export function execFileInGroup(
  file: string,
  args: readonly string[],
  options: GroupExecOptions,
  callback: (error: ExecError | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const { timeout, signal, maxBuffer = 1024 * 1024, encoding: _encoding, ...rest } = options;
  const cmd = [file, ...args].join(" ");
  let stdout = "", stderr = "", stopped = false, overflow = false, finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopGroup(child);
  };
  const finish = (error: ExecError | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    callback(error ? Object.assign(error, { cmd, stdout, stderr, ...(stopped ? { killed: true } : {}) }) : null, stdout, stderr);
  };
  const child = spawn(file, args, { ...rest, ...OWN_GROUP, stdio: ["pipe", "pipe", "pipe"] });
  const take = (which: "stdout" | "stderr") => (chunk: string) => {
    if (which === "stdout") stdout += chunk; else stderr += chunk;
    if (!overflow && stdout.length + stderr.length > maxBuffer) { overflow = true; stop(); }
  };
  child.stdout!.setEncoding("utf8").on("data", take("stdout"));
  child.stderr!.setEncoding("utf8").on("data", take("stderr"));
  // A child that exits before reading its input must not surface as an unhandled EPIPE.
  child.stdin!.on("error", () => {});
  child.once("error", (error) => finish(error));
  child.once("close", (code, exitSignal) => {
    if (overflow) return finish(Object.assign(new RangeError(`${file} wrote more than ${maxBuffer} bytes`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
    if (code === 0 && !exitSignal) return finish(null);
    finish(Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code, signal: exitSignal }));
  });
  if (timeout) {
    timer = setTimeout(stop, timeout);
    timer.unref?.();
  }
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return child;
}

/** execFileInGroup as a promise, shaped as `promisify(execFile)`'s: rejects with `code`, `killed`, `stdout` and `stderr`. */
export function execFileInGroupAsync(file: string, args: readonly string[], options: GroupExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileInGroup(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}
