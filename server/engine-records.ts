// Engines and the other CLIs spawnCli starts lead POSIX sessions of their own (procs.ts), so nothing signals them when the
// server dies: a server that is killed, or restarts in place in its container (server-launcher.ts), leaves them running.
// Each server run writes down what it starts under <data>/engine-runs/<run tag>/, and the next server of the same data
// folder stops what an earlier, no longer running, server left. A process counts as that run's only when it carries the
// run's random tag in its environment (spawnCli puts it there, and children inherit it), or when it is a recorded leader
// with the same start time; nothing is ever found by name. agent-browser daemons and their Chromes are left to the
// browser sweep, which closes them so they save their sign-ins. Windows: off (engines there are not detached).
import { randomBytes } from "node:crypto";
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_TAG_ENV = "OMB_ENGINE_TAG";
/** In the data folder; this machine's own, never backed up or moved. */
export const ENGINE_RUNS_DIR = "engine-runs";
const TAG = /^[0-9a-f]{32}$/;

type Started = { pid: number; start: string };
type Listed = { pid: number; start: string; zombie: boolean; env: Map<string, string> | null };

let run: { dir: string; tag: string } | null = null;

/** The tag spawnCli adds to a child's environment, or null before startEngineRecords (tests, other processes). */
export function engineRunTag(): string | null {
  return run?.tag ?? null;
}

const PS = process.platform === "darwin" ? "/bin/ps" : "ps";

function psText(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(PS, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => done(error ? null : stdout));
  });
}

function linuxStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

function environment(entries: string[]): Map<string, string> {
  return new Map(entries.flatMap((entry) => {
    const at = entry.indexOf("=");
    return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)] as const] : [];
  }));
}

/** Every process with its start time and, where the system shows it to this user, its environment. */
async function processes(): Promise<Listed[] | null> {
  if (process.platform === "linux") {
    let names: string[];
    try { names = readdirSync("/proc"); } catch { return null; }
    return names.filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        let env: Map<string, string> | null = null;
        try { env = environment(readFileSync(`/proc/${name}/environ`, "utf8").split("\0")); } catch {}
        return [{ pid: Number(name), start: fields[19] ?? "", zombie: fields[0] === "Z" || fields[0] === "X", env }];
      } catch { return []; }
    });
  }
  // macOS: `ps -E` appends the environment, space separated, for this user's processes; lstart is five words.
  const listing = await psText(["-A", "-E", "-ww", "-o", "pid=,stat=,lstart=,command="]);
  if (listing === null) return null;
  return listing.split("\n").flatMap((line) => {
    const [pid, stat, ...rest] = line.trim().split(/\s+/);
    if (!pid || !/^\d+$/.test(pid)) return [];
    return [{ pid: Number(pid), start: rest.slice(0, 5).join(" "), zombie: stat?.startsWith("Z") === true, env: environment(rest.slice(5)) }];
  });
}

function startOf(pid: number): string | null {
  if (process.platform === "linux") return linuxStart(pid);
  try { return execFileSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim() || null; }
  catch { return null; }
}

/** Starts recording for this server and stops what earlier servers of `dataDir` left. Resolves once that sweep is done. */
export async function startEngineRecords(dataDir: string, log: (line: string) => void = console.info): Promise<void> {
  if (process.platform === "win32" || run) return;
  const root = join(dataDir, ENGINE_RUNS_DIR);
  const tag = randomBytes(16).toString("hex");
  const dir = join(root, tag);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "server.json"), JSON.stringify({ pid: process.pid, start: startOf(process.pid) }), { mode: 0o600 });
  } catch (error) {
    log(`engine records: could not write ${dir} (${error instanceof Error ? error.message : String(error)}); engines left by this server are not stopped at the next start`);
    return;
  }
  run = { dir, tag };
  let earlier: string[];
  try { earlier = readdirSync(root).filter((name) => name !== tag && TAG.test(name)); } catch { return; }
  for (const other of earlier) await sweepRun(join(root, other), other, log).catch((error) => log(`engine records: ${other}: ${error instanceof Error ? error.message : String(error)}`));
}

async function sweepRun(dir: string, tag: string, log: (line: string) => void): Promise<void> {
  let server: Partial<Started> = {};
  try { server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) as Partial<Started>; } catch {}
  // Never another live server's: the data folder's lease allows one, but its records are its own while it runs.
  if (Number.isInteger(server.pid) && server.pid !== process.pid && server.start && startOf(server.pid!) === server.start) return;
  const leaders = new Map<number, string>();
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<Started>;
        if (Number.isInteger(record.pid) && typeof record.start === "string" && record.start) leaders.set(record.pid!, record.start);
      } catch {}
    }
  } catch { return; }
  const theirs = async (): Promise<number[] | null> => {
    const table = await processes();
    if (!table) return null;
    return table.filter((entry) => !entry.zombie && entry.pid !== process.pid && entry.env?.get("AGENT_BROWSER_DAEMON") !== "1"
      && (entry.env?.get(ENGINE_TAG_ENV) === tag || leaders.get(entry.pid) === entry.start))
      .map((entry) => entry.pid);
  };
  let left = await theirs();
  if (left === null) return;
  if (left.length) {
    log(`Stopping ${left.length} process${left.length === 1 ? "" : "es"} an earlier OpenMausBot server of this data folder started and left running.`);
    signal(left, "SIGTERM");
    for (const until = Date.now() + 1_500; Date.now() < until && left.length; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = await theirs() ?? left;
    }
    // Read again right before: only processes still carrying the tag (or the recorded start) are killed.
    signal(left, "SIGKILL");
    for (const until = Date.now() + 1_000; Date.now() < until && left.length; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = await theirs() ?? left;
    }
  }
  if (left.length) log(`engine records: ${left.length} process(es) of an earlier server did not stop`);
  else rmSync(dir, { recursive: true, force: true });
}

function signal(pids: number[], value: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, value); } catch {}
  }
}

/** Writes down a child spawnCli started in a session of its own; the record goes once the child and its group have gone. */
export function recordEngine(child: ChildProcess, start: string | null): void {
  const pid = child.pid;
  if (!run || !pid) return;
  const file = join(run.dir, `${pid}.json`);
  try { writeFileSync(file, JSON.stringify({ pid, start }), { mode: 0o600 }); } catch { return; }
  child.once("exit", () => {
    // Its group can outlive it (an MCP server it started); then the record stays for the next start's sweep.
    try { process.kill(-pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") forget(file);
    }
  });
  stoppedFiles.set(child, file);
}

const stoppedFiles = new WeakMap<ChildProcess, string>();

function forget(file: string): void {
  try { rmSync(file, { force: true }); } catch {}
}

/** killCliTree confirmed the whole tree gone. */
export function engineStopped(child: ChildProcess): void {
  const file = stoppedFiles.get(child);
  if (file) forget(file);
}

/** For tests: forget this process's run. */
export function resetEngineRecordsForTest(): void {
  run = null;
}
