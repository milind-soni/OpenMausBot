// Cross-platform process spawning for the agent CLIs. Three Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, readlink } from "node:fs/promises";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

interface OwnedProcess {
  pid: number;
  executable: string;
  startIdentity: string;
}

let processRegistryDir: string | null = null;
const ownedProcesses = new Map<number, OwnedProcess>();

type ProcessIdentityProbe =
  | { status: "found"; executable: string; startIdentity: string }
  | { status: "not-found" | "unavailable" };

function execText(file: string, args: string[], options: ExecFileOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function missingProcessError(error: unknown): boolean {
  const value = error as NodeJS.ErrnoException & { stderr?: string };
  return value.code === "ESRCH" || /cannot find a process|no process found|process.*not found/i.test(String(value.stderr ?? value.message));
}

export async function processIdentity(pid: number): Promise<ProcessIdentityProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unavailable" };
  if (process.platform === "win32") {
    try {
      const script = [
        `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
        "$path = $null",
        "try { $path = $p.Path } catch {}",
        "[pscustomobject]@{ CreationDate = $p.StartTime.ToUniversalTime().ToString('o'); ExecutablePath = $path; Name = $p.ProcessName } | ConvertTo-Json -Compress",
      ].join("; ");
      const value = JSON.parse((await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 2_000,
        windowsHide: true,
      })).trim()) as { CreationDate?: string; ExecutablePath?: string; Name?: string };
      if (!value.CreationDate) return { status: "unavailable" };
      return {
        status: "found",
        startIdentity: value.CreationDate,
        executable: basename(value.ExecutablePath || value.Name || ""),
      };
    } catch (error) {
      return { status: missingProcessError(error) ? "not-found" : "unavailable" };
    }
  }

  if (process.platform === "linux") {
    try {
      const stat = await readFileAsync(`/proc/${pid}/stat`, "utf8");
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 2) return { status: "unavailable" };
      const executableName = stat.slice(stat.indexOf("(") + 1, closingParen);
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      const startIdentity = fields[19];
      if (!startIdentity) return { status: "unavailable" };
      let executable = executableName;
      try { executable = basename(await readlink(`/proc/${pid}/exe`)); } catch {}
      return { status: "found", startIdentity, executable };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "unavailable" };
    }
  }

  try {
    const value = (await execText("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
      timeout: 1_000,
      windowsHide: true,
    })).trim();
    const match = value.match(/^(.{24})\s+(.+)$/);
    if (!match) return { status: "unavailable" };
    return { status: "found", startIdentity: match[1]!.trim(), executable: basename(match[2]!.trim()) };
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    return { status: code === 1 || missingProcessError(error) ? "not-found" : "unavailable" };
  }
}

function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists; only ESRCH proves that it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function registryFile(ownerPid = process.pid): string | null {
  return processRegistryDir ? join(processRegistryDir, `${ownerPid}.json`) : null;
}

function writeProcessRegistry(): void {
  const path = registryFile();
  if (!path) return;
  mkdirSync(processRegistryDir!, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({
      schema: "openmaus.owned-process-groups.v1",
      ownerPid: process.pid,
      children: [...ownedProcesses.values()],
    }, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch {}
  }
}

function unregisterOwnedProcess(pid: number): void {
  if (!ownedProcesses.delete(pid)) return;
  writeProcessRegistry();
}

/** Reap only process groups whose former owner is dead and whose PID still
 * matches the recorded OS start identity and executable. */
export async function configureProcessRegistry(directory: string): Promise<void> {
  processRegistryDir = directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory).filter((item) => /^\d+\.json$/.test(item))) {
    const path = join(directory, name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: string; ownerPid?: number; children?: OwnedProcess[] };
      if (value.schema !== "openmaus.owned-process-groups.v1" || value.ownerPid === process.pid) continue;
      if (ownerAlive(Number(value.ownerPid))) continue;
      for (const child of Array.isArray(value.children) ? value.children : []) {
        const observed = await processIdentity(Number(child.pid));
        if (observed.status !== "found" || observed.startIdentity !== child.startIdentity || observed.executable !== child.executable) continue;
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        } else {
          try { process.kill(-child.pid, "SIGTERM"); } catch {}
          setTimeout(() => {
            void processIdentity(Number(child.pid)).then((remaining) => {
              if (remaining.status !== "found" || remaining.startIdentity !== child.startIdentity || remaining.executable !== child.executable) return;
              try { process.kill(-child.pid, "SIGKILL"); } catch {}
            });
          }, 5_000).unref();
        }
      }
      unlinkSync(path);
    } catch {
      // Malformed or raced registry files are not authority to kill anything.
    }
  }
  writeProcessRegistry();
}

export function clearProcessRegistry(): void {
  const path = registryFile();
  if (path) try { unlinkSync(path); } catch {}
  ownedProcesses.clear();
  processRegistryDir = null;
}

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three

  if (child.pid && processRegistryDir) {
    const pid = child.pid;
    let registered = false;
    const registrationDeadline = Date.now() + 10_000;
    const register = async () => {
      if (registered || child.exitCode !== null || child.signalCode !== null) return;
      const observed = await processIdentity(pid);
      if (observed.status !== "found") {
        // A freshly spawned Windows process can be visible to Get-Process
        // before StartTime or Path is readable, which is an unavailable
        // probe rather than not-found. Both states are transient during this
        // bounded registration window; retry either instead of abandoning
        // ownership after the first partial PowerShell result.
        if (Date.now() < registrationDeadline) {
          setTimeout(() => void register(), 100).unref();
        }
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      registered = true;
      ownedProcesses.set(pid, { pid, executable: observed.executable, startIdentity: observed.startIdentity });
      writeProcessRegistry();
      child.once("close", () => unregisterOwnedProcess(pid));
    };
    void register();
  }

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  execFile(resolved.command, resolved.args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
    cb(err, stdout, stderr),
  );
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (err) {
        try {
          // taskkill is unavailable or the tree lookup failed. At least stop
          // the process we own instead of leaving the entire turn running.
          child.kill();
        } catch {
          /* already gone */
        }
      }
      unregisterOwnedProcess(pid);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  unregisterOwnedProcess(pid);
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    ? `\\\\.\\pipe\\openmausbot-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
