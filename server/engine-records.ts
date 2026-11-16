// Engines and the other CLIs spawnCli starts lead POSIX sessions of their own (procs.ts), so nothing signals them when the
// server dies: a server that is killed, or restarts in place in its container (server-launcher.ts), leaves them running.
// Each server run writes down what it starts under <data>/engine-runs/<run tag>/. A server that shuts down cleanly has
// stopped its engines itself and marks its run clean: nothing of it is ever swept. After an unclean death, the next server
// of the same data folder stops what that run left, and only that: a recorded leader that is still the same process (same
// boot, same start time), and processes carrying the run's random tag (spawnCli puts it in the environment, and children
// inherit it) that are still in a recorded leader's process group or session. A daemon an engine started that left for a
// session of its own (an adb server, tmux, pm2, a dev server, a browser) carries the tag too, and is never touched; nothing
// is ever found by name. agent-browser daemons and their Chromes are left to the browser sweep, which closes them so they
// save their sign-ins. Windows: off (engines there are not detached).
import { randomBytes } from "node:crypto";
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_TAG_ENV = "OMB_ENGINE_TAG";
/** In the data folder; this machine's own, never backed up or moved. */
export const ENGINE_RUNS_DIR = "engine-runs";
const TAG = /^[0-9a-f]{32}$/;
/** Written by a server whose shutdown finished: it stopped its own engines, and what they left on purpose stays. */
const CLEAN = "clean";

/** `start`: the kernel's start tick on Linux, ps's lstart elsewhere; `at`: when spawn returned (ms), where no start was read. */
type Leader = { start: string | null; at: number | null };
type ServerRecord = { pid?: unknown; start?: unknown; boot?: unknown; ns?: unknown };
/** `sid` only where the system shows it (Linux); macOS's ps prints no session id. */
export type Listed = { pid: number; start: string; zombie: boolean; pgid: number; sid: number | null; env: Map<string, string> | null };

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

function linuxStat(pid: number | string): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch { return null; }
}

function environment(entries: string[]): Map<string, string> {
  return new Map(entries.flatMap((entry) => {
    const at = entry.indexOf("=");
    return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)] as const] : [];
  }));
}

/** Every process with its start time, group, session and, where the system shows it to this user, its environment. */
async function processes(): Promise<Listed[] | null> {
  if (process.platform === "linux") {
    let names: string[];
    try { names = readdirSync("/proc"); } catch { return null; }
    return names.filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      const fields = linuxStat(name);
      if (!fields) return [];
      let env: Map<string, string> | null = null;
      try { env = environment(readFileSync(`/proc/${name}/environ`, "utf8").split("\0")); } catch {}
      return [{ pid: Number(name), start: fields[19] ?? "", zombie: fields[0] === "Z" || fields[0] === "X", pgid: Number(fields[2]), sid: Number(fields[3]), env }];
    });
  }
  // macOS: `ps -E` appends the environment, space separated, for this user's processes; lstart is five words.
  const listing = await psText(["-A", "-E", "-ww", "-o", "pid=,stat=,pgid=,lstart=,command="]);
  if (listing === null) return null;
  return listing.split("\n").flatMap((line) => {
    const [pid, stat, pgid, ...rest] = line.trim().split(/\s+/);
    if (!pid || !/^\d+$/.test(pid) || !pgid || !/^\d+$/.test(pgid)) return [];
    return [{ pid: Number(pid), start: rest.slice(0, 5).join(" "), zombie: stat?.startsWith("Z") === true, pgid: Number(pgid), sid: null, env: environment(rest.slice(5)) }];
  });
}

function startOf(pid: number): string | null {
  if (process.platform === "linux") return linuxStat(pid)?.[19] ?? null;
  try { return execFileSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim() || null; }
  catch { return null; }
}

/** Random per boot (Linux boot_id, macOS kern.bootsessionuuid): a pid and its start tick mean nothing across a reboot, as a
 * restarted VM with its volume restored has. */
function bootId(): string | null {
  try {
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    if (process.platform === "darwin") return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {}
  return null;
}

/** A container's processes live in a pid namespace of their own; one container cannot see or signal another's. */
function pidNamespace(): string | null {
  if (process.platform !== "linux") return null;
  try { return readlinkSync("/proc/self/ns/pid"); } catch { return null; }
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One process from two readings: the start tick (Linux) or lstart string, or on macOS within 2 s of when spawn returned. */
function sameStart(leader: Leader, listed: string): boolean {
  if (leader.start) return leader.start === listed;
  if (leader.at === null) return false;
  const seen = Date.parse(listed);
  return Number.isFinite(seen) && Math.abs(seen - leader.at) < 2_000;
}

/** Started before this server: nothing this server starts can be an earlier run's. Unknown on either side counts as before. */
function startedBefore(listed: string, self: string | null): boolean {
  if (!self || !listed) return true;
  if (process.platform === "linux") return Number(listed) < Number(self);
  const [a, b] = [Date.parse(listed), Date.parse(self)];
  return !Number.isFinite(a) || !Number.isFinite(b) || a < b;
}

export interface SweepSelf { pid: number; tag: string | null; start: string | null }

/** What of an earlier, dead run `tag` with `leaders` is still running in `table`: see the note at the top. */
export function leftBehind(table: readonly Listed[], tag: string, leaders: ReadonlyMap<number, Leader>, self: SweepSelf): number[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  // A group or session id is a recorded leader's only while that pid is not some other process: the system gives no new
  // process a number that still names a group or session, so with the leader gone, the id is still its.
  const leadersGroup = (id: number | null) => {
    const leader = id === null ? undefined : leaders.get(id);
    if (!leader) return false;
    const holder = byPid.get(id!);
    return !holder || sameStart(leader, holder.start);
  };
  return table.filter((entry) => {
    if (entry.zombie || entry.pid === self.pid || entry.pid <= 1) return false;
    const tagged = entry.env?.get(ENGINE_TAG_ENV);
    if ((self.tag && tagged === self.tag) || entry.env?.get("AGENT_BROWSER_DAEMON") === "1" || !startedBefore(entry.start, self.start)) return false;
    const leader = leaders.get(entry.pid);
    if (leader && sameStart(leader, entry.start)) return true;
    return tagged === tag && (leadersGroup(entry.pgid) || leadersGroup(entry.sid));
  }).map((entry) => entry.pid);
}

/** Starts recording for this server and stops what earlier servers of `dataDir` left. Resolves once that sweep is done. It
 * runs alongside the server's own start: what this server starts carries its own tag, and nothing that started after this
 * server (`cutoff`, its own start unless a test plays both servers in one process) is ever taken for an earlier run's. */
export async function startEngineRecords(dataDir: string, log: (line: string) => void = console.info, cutoff?: string | null): Promise<void> {
  if (process.platform === "win32" || run) return;
  const root = join(dataDir, ENGINE_RUNS_DIR);
  const tag = randomBytes(16).toString("hex");
  const dir = join(root, tag);
  const start = startOf(process.pid);
  const self = { pid: process.pid, tag, start: cutoff === undefined ? start : cutoff, boot: bootId(), ns: pidNamespace() };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "server.json"), JSON.stringify({ pid: self.pid, start, boot: self.boot, ns: self.ns }), { mode: 0o600 });
  } catch (error) {
    log(`engine records: could not write ${dir} (${error instanceof Error ? error.message : String(error)}); engines left by this server are not stopped at the next start`);
    return;
  }
  run = { dir, tag };
  let earlier: string[];
  try { earlier = readdirSync(root).filter((name) => name !== tag && TAG.test(name)); } catch { return; }
  for (const other of earlier) await sweepRun(join(root, other), other, self, log).catch((error) => log(`engine records: ${other}: ${error instanceof Error ? error.message : String(error)}`));
}

/** Whether an earlier run's server still runs: "gone" from another boot or another container (none of its processes is
 * here), "dead" on this boot, "unknown" when that cannot be told (its folder is then left alone). */
function serverState(server: ServerRecord, self: { pid: number; boot: string | null; ns: string | null }): "alive" | "dead" | "gone" | "unknown" {
  if (!Number.isInteger(server.pid) || (server.pid as number) <= 0) return "unknown";
  if (typeof server.boot === "string" && self.boot && server.boot !== self.boot) return "gone";
  // This server holds the data folder's lease, so that container's server has ended, and its processes with it.
  if (typeof server.ns === "string" && self.ns && server.ns !== self.ns) return "gone";
  const pid = server.pid as number;
  if (pid === self.pid || !exists(pid)) return "dead";
  if (typeof server.start !== "string" || !server.start) return "unknown";
  const now = startOf(pid);
  return now === null ? "unknown" : now === server.start ? "alive" : "dead";
}

async function sweepRun(dir: string, tag: string, self: SweepSelf & { boot: string | null; ns: string | null }, log: (line: string) => void): Promise<void> {
  const forgetRun = () => rmSync(dir, { recursive: true, force: true });
  if (existsSync(join(dir, CLEAN))) return forgetRun();
  let server: ServerRecord;
  try { server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) as ServerRecord; } catch { return; }
  const state = serverState(server, self);
  if (state === "gone") return forgetRun();
  // Never another live server's: the data folder's lease allows one, but its records are its own while it runs.
  if (state !== "dead") return;
  const leaders = new Map<number, Leader>();
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; start?: unknown; at?: unknown };
        if (!Number.isInteger(record.pid)) continue;
        const start = typeof record.start === "string" && record.start ? record.start : null;
        const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null;
        if (start || at !== null) leaders.set(record.pid as number, { start, at });
      } catch {}
    }
  } catch { return; }
  const theirs = async (): Promise<number[] | null> => {
    const table = await processes();
    return table && leftBehind(table, tag, leaders, self);
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
    // Read again right before: only processes still that run's are killed.
    signal(left, "SIGKILL");
    for (const until = Date.now() + 1_000; Date.now() < until && left.length; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = await theirs() ?? left;
    }
  }
  if (left.length) log(`engine records: ${left.length} process(es) of an earlier server did not stop`);
  else forgetRun();
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
  try { writeFileSync(file, JSON.stringify({ pid, start, at: Date.now() }), { mode: 0o600 }); } catch { return; }
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

/** At a graceful exit: when nothing this run recorded still runs (its engines' groups are all gone), the run is marked
 * clean and the next start sweeps nothing of it. What its engines started in sessions of their own stays running. */
export function markEngineRunClean(): boolean {
  if (!run) return false;
  try {
    for (const name of readdirSync(run.dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        process.kill(-Number(name.slice(0, -".json".length)), 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      forget(join(run.dir, name));
    }
    writeFileSync(join(run.dir, CLEAN), "", { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** For tests: forget this process's run. */
export function resetEngineRecordsForTest(): void {
  run = null;
}
