// The runtime processes each Antigravity account has running, so a sign-out can wait for them to end, and the ones a
// server that has since ended left running on Windows.
import { execFile, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

import { DATA_DIR } from "../config.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { killCliTree } from "../procs.ts";

const EXIT_WAIT_MS = 7_000;

export class AntigravityProcesses {
  readonly #running = new Map<string, Set<ChildProcess>>();

  track(instanceId: string, child: ChildProcess): void {
    const children = this.#running.get(instanceId) ?? new Set<ChildProcess>();
    this.#running.set(instanceId, children);
    children.add(child);
    const forget = () => {
      children.delete(child);
      if (!children.size && this.#running.get(instanceId) === children) this.#running.delete(instanceId);
    };
    child.once("close", forget);
    child.once("error", () => { if (child.pid === undefined) forget(); });
  }

  count(instanceId: string): number {
    return this.#running.get(instanceId)?.size ?? 0;
  }

  /** Each of this account's processes was asked to exit and gets `waitMs` before it is killed, then `waitMs` more to go.
   * Resolves false when one is still there. */
  async stopped(instanceId: string, waitMs = EXIT_WAIT_MS): Promise<boolean> {
    const children = [...this.#running.get(instanceId) ?? []];
    const gone = await Promise.all(children.map((child) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const finish = (gone: boolean) => {
        clearTimeout(timer);
        clearTimeout(giveUp);
        child.off("close", closed);
        resolve(gone);
      };
      const closed = () => finish(true);
      const timer = setTimeout(() => {
        void killCliTree(child).catch(() => false);
        giveUp = setTimeout(() => finish(false), waitMs);
        giveUp.unref?.();
      }, waitMs);
      timer.unref?.();
      child.once("close", closed);
    })));
    return gone.every(Boolean);
  }
}

/** A runtime process as Windows lists it; start times are UTC strings, which sort as they compare. */
export interface RuntimeProcessRow {
  pid: number;
  path: string;
  started: string;
  /** Null when the parent is gone. */
  parentStarted: string | null;
}

const RUNTIME_IMAGES = new Set(["agy_acp_server.exe", "localharness_external.exe"]);

/** The runtime processes, from this app's own releases, whose parent is gone: a parent started after its child holds a
 * reused pid. A live parent (this server, or the runtime that started a harness) keeps its child. */
export function orphanedRuntimeProcesses(rows: RuntimeProcessRow[], runtimesRoot: string): RuntimeProcessRow[] {
  const root = `${win32.resolve(runtimesRoot).toLowerCase()}\\`;
  return rows.filter((row) => {
    const path = win32.resolve(row.path).toLowerCase();
    return path.startsWith(root) && RUNTIME_IMAGES.has(win32.basename(path)) && (row.parentStarted === null || row.parentStarted > row.started);
  });
}

/** The folder goes in through the environment, so no path is ever quoted into the script. */
const WINDOWS_RUNTIME_PROCESSES = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $r = $env:OMB_AGY_RUNTIMES.TrimEnd('\\') + '\\'; $all = @(Get-CimInstance Win32_Process); $by = @{}; foreach ($p in $all) { $by[$p.ProcessId] = $p }"
  + " ; ConvertTo-Json -Compress -InputObject @($all | Where-Object { $_.CreationDate -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) }"
  + " | ForEach-Object { $q = $by[$_.ParentProcessId]; [pscustomobject]@{ ProcessId = $_.ProcessId; ExecutablePath = $_.ExecutablePath;"
  + " Started = $_.CreationDate.ToUniversalTime().ToString('o'); ParentStarted = $(if ($q -and $q.CreationDate) { $q.CreationDate.ToUniversalTime().ToString('o') }) } })";

/** Each `pid=started` is stopped with its tree only while that pid still runs the process that was listed, and waited for:
 * its unpacked folder stays locked until it has exited. Writes the pid of each one stopped and gone, one per line. */
const WINDOWS_STOP_PROCESSES = "foreach ($e in $env:OMB_AGY_STOP.Split(' ')) { $id, $s = $e.Split('='); $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]$id)"
  + "; if ($p -and $p.CreationDate -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $s) { taskkill /PID $id /T /F | Out-Null"
  + "; if ($LASTEXITCODE -eq 0) { Wait-Process -Id $id -Timeout 10 -ErrorAction SilentlyContinue; if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { $id } } } }; exit 0";

type PowerShell = (script: string, env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<string | null>;

/** A script that fails or runs out of time still gives the lines it wrote in full; a line it was writing is dropped. */
const powershell: PowerShell = (script, env, timeoutMs = 30_000) => new Promise((done) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env },
  }, (error, stdout) => done(error ? stdout.slice(0, stdout.lastIndexOf("\n") + 1) || null : stdout));
});

function listedRows(listing: string | null): RuntimeProcessRow[] {
  let rows: unknown;
  try { rows = JSON.parse((listing ?? "").replace(/^\uFEFF/, "")); } catch { return []; }
  return (Array.isArray(rows) ? rows : [rows]).flatMap((row) => {
    const { ProcessId: pid, ExecutablePath: path, Started: started, ParentStarted: parentStarted } = (row ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(pid) || typeof path !== "string" || typeof started !== "string" || !started) return [];
    return [{ pid: pid as number, path, started, parentStarted: typeof parentStarted === "string" && parentStarted ? parentStarted : null }];
  });
}

export interface OrphanStopOptions {
  platform?: NodeJS.Platform;
  dataDir?: string;
  run?: PowerShell;
}

/** Windows keeps a child running when its parent ends: each runtime a crashed or killed server left behind keeps its memory
 * and its unpacked folder (0.3-1.3 GB) until it is stopped. Resolves to how many were stopped and have exited. */
export async function stopOrphanedAntigravityRuntimes(options: OrphanStopOptions = {}): Promise<number> {
  if ((options.platform ?? process.platform) !== "win32") return 0;
  const run = options.run ?? powershell;
  const root = antigravityRuntimesRoot(options.dataDir ?? DATA_DIR);
  const orphans = orphanedRuntimeProcesses(listedRows(await run(WINDOWS_RUNTIME_PROCESSES, { OMB_AGY_RUNTIMES: root })), root);
  if (!orphans.length) return 0;
  // Each stop may wait up to 10 s for its runtime to exit.
  const stopped = await run(WINDOWS_STOP_PROCESSES, { OMB_AGY_STOP: orphans.map(({ pid, started }) => `${pid}=${started}`).join(" ") }, 30_000 + orphans.length * 15_000);
  const gone = new Set(stopped?.split(/\s+/));
  return orphans.filter(({ pid }) => gone.has(String(pid))).length;
}

let orphansStopped: Promise<number> | undefined;

/** Once per server: a runtime this server starts keeps it as its parent while it runs. */
export function stopOrphanedAntigravityRuntimesOnce(): Promise<number> {
  orphansStopped ??= stopOrphanedAntigravityRuntimes().catch((error) => {
    console.warn(`antigravity: could not stop runtimes left by an earlier run: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  });
  return orphansStopped;
}
