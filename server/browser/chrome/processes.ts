import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface RegisteredProcess {
  pid: number;
  /** The system's start time for the pid, so a reused pid is never mistaken for it. */
  startTime: string | null;
  userDataDir: string;
  /** The server that launched it. */
  ownerPid: number;
  launchedAt: string;
}

/** `<browser root>/processes.json`: every Chrome this data directory's servers launched and have not seen exit. */
export class ProcessRegistry {
  readonly file: string;
  readonly #reserved = new Map<string, number>();

  constructor(browserRootDir: string) {
    this.file = join(browserRootDir, "processes.json");
  }

  list(): RegisteredProcess[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((entry): entry is RegisteredProcess => typeof entry?.pid === "number" && typeof entry?.userDataDir === "string") : [];
    } catch {
      return [];
    }
  }

  #write(entries: RegisteredProcess[]): void {
    mkdirSync(resolve(this.file, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  add(entry: RegisteredProcess): void {
    this.#write([...this.list().filter((existing) => existing.pid !== entry.pid), entry]);
  }

  remove(pid: number): void {
    const entries = this.list();
    if (entries.some((entry) => entry.pid === pid)) this.#write(entries.filter((entry) => entry.pid !== pid));
  }

  /** Holds a profile folder that a launch is preparing, before its Chrome is registered; the sweep leaves it alone. */
  reserve(userDataDir: string): () => void {
    const dir = resolve(userDataDir);
    this.#reserved.set(dir, (this.#reserved.get(dir) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.#reserved.get(dir) ?? 0;
      if (count > 1) this.#reserved.set(dir, count - 1);
      else this.#reserved.delete(dir);
    };
  }

  reserved(userDataDir: string): boolean {
    return this.#reserved.has(resolve(userDataDir));
  }
}

export interface ListedProcess {
  pid: number;
  ppid: number;
  startTime: string | null;
  args: string;
  /** Exact arguments where the system keeps them apart (Linux). */
  argv?: string[];
}

function execText(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => done(error ? null : stdout));
  });
}

function linuxProcesses(): ListedProcess[] | null {
  let names: string[];
  try { names = readdirSync("/proc"); } catch { return null; }
  const found: ListedProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      found.push({ pid: Number(name), ppid: Number(fields[1]), startTime: fields[19] ?? null, args: argv.join(" "), argv });
    } catch {}
  }
  return found;
}

/** Every process with its arguments, or null where the system will not list them. */
export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ListedProcess[] | null> {
  if (platform === "linux") return linuxProcesses();
  if (platform === "win32") {
    const json = await execText("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name LIKE '%chrome%'\" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (json === null) return null;
    if (!json.trim()) return [];
    try {
      const parsed = JSON.parse(json) as unknown;
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId: number; ParentProcessId: number; CreationDate?: unknown; CommandLine?: string | null }>;
      return rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, startTime: row.CreationDate === undefined ? null : String(row.CreationDate), args: row.CommandLine ?? "" }));
    } catch {
      return null;
    }
  }
  const listing = await execText("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,args="]);
  if (listing === null) return null;
  const found: ListedProcess[] = [];
  for (const line of listing.split("\n")) {
    const [pid, ppid, ...rest] = line.trim().split(/\s+/);
    if (!pid || !/^\d+$/.test(pid) || !ppid || !/^\d+$/.test(ppid)) continue;
    // lstart is always five words in the C locale (Tue Oct 13 23:48:58 2026).
    found.push({ pid: Number(pid), ppid: Number(ppid), startTime: rest.slice(0, 5).join(" "), args: rest.slice(5).join(" ") });
  }
  return found;
}

/** The --user-data-dir of a process; paths may hold spaces where the system joins arguments with them. */
export function userDataDirOf(listed: Pick<ListedProcess, "args" | "argv">): string | null {
  const exact = listed.argv?.find((arg) => arg.startsWith("--user-data-dir="));
  if (exact) return exact.slice("--user-data-dir=".length);
  const quoted = /(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)")/.exec(listed.args);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const bare = /--user-data-dir=(.+?)(?=\s+--|\s+(?:about:blank|https?:\/\/|data:)|$)/.exec(listed.args);
  return bare?.[1]?.trim() ?? null;
}

/** Chrome's browser process; its renderers and helpers all carry --type=. */
export function isBrowserProcess(listed: Pick<ListedProcess, "args" | "argv">): boolean {
  return userDataDirOf(listed) !== null && !/(?:^|\s|")--type=/.test(listed.args);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Browsers on OMB's profiles that no live server registered: left behind by a crash or a force-quit. */
export function strays({ processes, registered, root, alive = processAlive }: {
  processes: readonly ListedProcess[];
  registered: readonly RegisteredProcess[];
  root: string;
  alive?: (pid: number) => boolean;
}): ListedProcess[] {
  return processes.filter((listed) => {
    if (!isBrowserProcess(listed)) return false;
    const dir = userDataDirOf(listed);
    if (!dir || !inside(root, dir)) return false;
    const entry = registered.find((candidate) => candidate.pid === listed.pid);
    if (!entry) return true;
    if (entry.startTime !== null && listed.startTime !== null && entry.startTime !== listed.startTime) return true;
    return !alive(entry.ownerPid);
  });
}

export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    await execText("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (const until = Date.now() + 2_000; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
    if (!processAlive(pid)) return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

/** POSIX Chrome locks a profile with a SingletonLock symlink to "<host>-<pid>"; one whose process is gone blocks the next launch. */
export function staleSingletonLock(dir: string, { host = hostname(), alive = processAlive }: { host?: string; alive?: (pid: number) => boolean } = {}): boolean {
  const lock = join(dir, "SingletonLock");
  let target: string;
  try {
    if (!lstatSync(lock).isSymbolicLink()) return false;
    target = readlinkSync(lock);
  } catch {
    return false;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match) return true;
  return match[1] !== host || !alive(Number(match[2]));
}

export function clearSingleton(dir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { unlinkSync(join(dir, name)); } catch {}
  }
}

export interface SweepReport {
  killed: number[];
  locksCleared: string[];
  temporaryRemoved: string[];
}

/** At boot and every minute: kill strays, clear stale profile locks, delete temporary profiles nothing runs on. */
export async function sweep({ root, registry, list = listProcesses, kill = killProcessTree, alive = processAlive, host = hostname() }: {
  root: string;
  registry: ProcessRegistry;
  list?: () => Promise<ListedProcess[] | null>;
  kill?: (pid: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  host?: string;
}): Promise<SweepReport> {
  const report: SweepReport = { killed: [], locksCleared: [], temporaryRemoved: [] };
  const processes = await list();
  if (processes === null) return report;
  const registered = registry.list();
  for (const stray of strays({ processes, registered, root, alive })) {
    await kill(stray.pid);
    report.killed.push(stray.pid);
  }
  for (const entry of registered) if (!alive(entry.pid) || report.killed.includes(entry.pid)) registry.remove(entry.pid);
  const inUse = new Set([
    ...processes.filter((listed) => isBrowserProcess(listed) && !report.killed.includes(listed.pid)).map((listed) => resolve(userDataDirOf(listed)!)),
    ...registry.list().map((entry) => resolve(entry.userDataDir)),
  ]);
  for (const folder of ["profiles", "temp"]) {
    const parent = join(root, folder);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent)) {
      const dir = join(parent, name);
      if (inUse.has(resolve(dir)) || registry.reserved(dir)) continue;
      if (folder === "temp") {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        report.temporaryRemoved.push(dir);
      } else if (staleSingletonLock(dir, { host, alive })) {
        clearSingleton(dir);
        report.locksCleared.push(dir);
      }
    }
  }
  return report;
}
