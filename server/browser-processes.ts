// agent-browser 0.37 starts each daemon in a session of its own (setsid) and each Chrome in its own process group, so neither
// stops with the server, and a killed daemon leaves its Chrome running, re-parented to init. Every process is recorded with
// its start time, so a pid the system has since given to another program is never signalled.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";

/** `started` tells a process from a later one that reused its pid; a zombie has exited and counts as gone. */
type ListedProcess = { ppid: number; pgid: number; zombie: boolean; started: string; args?: string };

export interface BrowserProcessTree {
  daemon: number;
  /** pid → start time; start times are empty where the system gives none (Windows). */
  members: Map<number, string>;
  /** Process groups a member leads; a helper Chrome started after the snapshot joins one. */
  groups: number[];
  /** Chrome's temporary profile folders, which the daemon removes only when it closes Chrome itself. */
  profiles?: string[];
  /** Windows gives no start times: the pid counts as the daemon only while it runs this image. */
  image?: string;
}

/** agent-browser's Chrome profile folder; only an absolute path of exactly this name, from Chrome's own arguments, is removed. */
const TEMPORARY_PROFILE = /^agent-browser-chrome-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function temporaryProfile(args: string | undefined): string | null {
  const dir = args?.split(" ").find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  return dir && isAbsolute(dir) && TEMPORARY_PROFILE.test(basename(dir)) ? dir : null;
}

/** macOS keeps ps at /bin/ps; a server started with a bare PATH (a test fixture's, a service's) still finds it there. */
const PS = process.platform === "darwin" ? "/bin/ps" : "ps";

/** The C locale keeps `ps` start times in one fixed five-word form. */
function execText(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => done(error ? null : stdout));
  });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxArgs(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); }
  catch { return ""; }
}

async function processArgs(pid: number): Promise<string | null> {
  if (process.platform === "linux") return linuxArgs(pid) || null;
  return (await execText(PS, ["-ww", "-o", "args=", "-p", String(pid)]))?.trim() || null;
}

/** Linux reads /proc (an image without procps still works), one file at a time so a busy host keeps its descriptors. */
async function processTable(withArgs = false): Promise<Map<number, ListedProcess> | null> {
  if (process.platform === "win32") return null;
  const table = new Map<number, ListedProcess>();
  if (process.platform === "linux") {
    let names: string[];
    try { names = readdirSync("/proc"); } catch { return null; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // The command name may hold spaces and parentheses; the fields follow its last ')'.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        table.set(Number(name), { ppid: Number(fields[1]), pgid: Number(fields[2]), zombie: fields[0] === "Z" || fields[0] === "X", started: fields[19] ?? "", ...withArgs ? { args: linuxArgs(Number(name)) } : {} });
      } catch {}
    }
    return table;
  }
  // lstart is always five words (Tue Oct 13 23:48:58 2026); args follow.
  const listing = await execText(PS, ["-A", "-ww", "-o", `pid=,ppid=,pgid=,stat=,lstart=${withArgs ? ",args=" : ""}`]);
  if (listing === null) return null;
  for (const line of listing.split("\n")) {
    const [pid, ppid, pgid, stat, ...rest] = line.trim().split(/\s+/);
    if (!pid || !Number.isInteger(Number(pid)) || !Number.isInteger(Number(ppid)) || !Number.isInteger(Number(pgid))) continue;
    table.set(Number(pid), { ppid: Number(ppid), pgid: Number(pgid), zombie: stat?.startsWith("Z") === true, started: rest.slice(0, 5).join(" "), ...withArgs ? { args: rest.slice(5).join(" ") } : {} });
  }
  return table;
}

async function processEnvironment(pid: number): Promise<Map<string, string> | null> {
  let entries: string[];
  if (process.platform === "linux") {
    try { entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return null; }
  } else {
    // ps -E appends the environment to the arguments, space separated.
    const listing = await execText(PS, ["-E", "-ww", "-o", "command=", "-p", String(pid)]);
    if (listing === null) return null;
    entries = listing.trim().split(/\s+/);
  }
  return new Map(entries.flatMap((entry) => {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(entry);
    return match ? [[match[1]!, match[2]!] as const] : [];
  }));
}

async function imageOf(pid: number): Promise<string | null> {
  const row = await execText("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return row === null ? null : /^"([^"]*)"/.exec(row.trim())?.[1]?.toLowerCase() ?? "";
}

/** agent-browser starts a daemon through the binary's resolved path with AGENT_BROWSER_DAEMON=1 and the session's name, so a
 * pid now running another program, command or session is not it. Read before the close: afterwards Chrome is re-parented. */
export async function browserProcessTree(binaryPath: string, daemon: number, session: string): Promise<BrowserProcessTree | null> {
  if (!Number.isInteger(daemon) || daemon <= 1 || daemon === process.pid || !processAlive(daemon)) return null;
  const paths = new Set([binaryPath]);
  try { paths.add(realpathSync(binaryPath)); } catch {}
  if (process.platform === "win32") {
    // Windows shows no environments, trees or start times: the image tells the daemon from a later program, and taskkill /T walks the tree.
    const image = await imageOf(daemon);
    return image && [...paths].some((path) => basename(path).toLowerCase() === image) ? { daemon, members: new Map([[daemon, ""]]), groups: [], image } : null;
  }
  const command = await processArgs(daemon);
  if (!command || ![...paths].some((path) => command === path || command.startsWith(`${path} `))) return null;
  const env = await processEnvironment(daemon);
  if (env?.get("AGENT_BROWSER_DAEMON") !== "1" || env.get("AGENT_BROWSER_SESSION") !== session) return null;
  const table = await processTable();
  if (!table?.has(daemon)) return null;
  const children = new Map<number, number[]>();
  for (const [pid, entry] of table) children.set(entry.ppid, [...children.get(entry.ppid) ?? [], pid]);
  const members = new Map<number, string>();
  const walk = (pid: number) => {
    members.set(pid, table.get(pid)!.started);
    for (const child of children.get(pid) ?? []) if (!members.has(child)) walk(child);
  };
  walk(daemon);
  const own = table.get(process.pid)?.pgid;
  const groups = [...members.keys()].filter((pid) => table.get(pid)!.pgid === pid && pid !== own);
  const profiles: string[] = [];
  for (const group of groups) {
    const profile = group === daemon ? null : temporaryProfile(await processArgs(group) ?? undefined);
    if (profile) profiles.push(profile);
  }
  return { daemon, members, groups, profiles };
}

/** Whether a Chrome's arguments name a profile folder inside `root`; a path may hold spaces where `ps` joins arguments with them. */
function profileUnder(args: string, root: string): boolean {
  return args.includes(`--user-data-dir=${root.replace(/[\\/]+$/, "")}${sep}`);
}

/** Chromes that outlived their daemon. agent-browser starts Chrome on an `agent-browser-chrome-` profile, or a saved session's
 * own profile under `profiles`, in its own group, and Chrome inherits AGENT_BROWSER_DAEMON=1 and the session's name. Only a
 * temporary profile is ever listed for removal. POSIX only: Windows lists no environments. */
export async function orphanedBrowsers(home: string | undefined, profiles?: string): Promise<Array<{ session: string; tree: BrowserProcessTree }>> {
  const table = await processTable(true);
  if (!table) return [];
  const found: Array<{ session: string; tree: BrowserProcessTree }> = [];
  for (const [pid, entry] of table) {
    const args = entry.args?.split(" ") ?? [];
    const onProfile = args.some((arg) => arg.startsWith("--user-data-dir=") && arg.includes("agent-browser-chrome-")) || (!!profiles && profileUnder(entry.args ?? "", profiles));
    if (entry.zombie || entry.pgid !== pid || !args.includes("--remote-debugging-port=0") || !onProfile) continue;
    // A daemon runs as agent-browser (or its platform build) with no arguments.
    const parent = table.get(entry.ppid);
    if (parent && !parent.zombie && entry.ppid > 1 && (/(?:^|\/)agent-browser[^/\s]*$/.test(parent.args ?? "") || (await processEnvironment(entry.ppid))?.get("AGENT_BROWSER_DAEMON") === "1")) continue;
    const env = await processEnvironment(pid);
    const session = env?.get("AGENT_BROWSER_SESSION");
    if (env?.get("AGENT_BROWSER_DAEMON") !== "1" || !session || !/^[A-Za-z0-9_.-]{1,96}$/.test(session) || (home && env.get("HOME") !== home)) continue;
    const profile = temporaryProfile(entry.args);
    found.push({ session, tree: { daemon: pid, members: new Map([[pid, entry.started]]), groups: [pid], profiles: profile ? [profile] : [] } });
  }
  return found;
}

/** The lock a daemon's own Chrome held when last checked, and that daemon: while both live, a call lists no processes. */
const heldProfiles = new Map<string, { target: string; daemon: number }>();

function namesProfile(args: string, dir: string): boolean {
  const flag = `--user-data-dir=${dir}`;
  for (let at = args.indexOf(flag); at >= 0; at = args.indexOf(flag, at + 1)) {
    if (at + flag.length === args.length || args[at + flag.length] === " ") return true;
  }
  return false;
}

async function daemonOf(pid: number, table: Map<number, ListedProcess>): Promise<number | null> {
  for (let parent = table.get(pid)?.ppid ?? 0, depth = 0; parent > 1 && depth < 3; parent = table.get(parent)?.ppid ?? 0, depth++) {
    if (table.get(parent)?.zombie) return null;
    if ((await processEnvironment(parent))?.get("AGENT_BROWSER_DAEMON") === "1") return parent;
  }
  return null;
}

/** POSIX Chrome locks its profile with a SingletonLock symlink to `<host>-<pid>`. A later launch on the profile hands itself
 * to the Chrome the lock names and exits, and refuses a lock that names another host (a renamed Mac, a moved Cloud volume).
 * A Chrome whose daemon was killed keeps running, re-parented, and would take every later launch, so it is stopped; then the
 * lock goes. A daemon's own Chrome keeps it. The profile's contents are never touched. */
export async function releaseBrowserProfile(dir: string | undefined): Promise<void> {
  if (!dir || process.platform === "win32") return;
  let target: string;
  try { target = readlinkSync(join(dir, "SingletonLock")); }
  catch { heldProfiles.delete(dir); return; }
  const match = /^(.*)-(\d+)$/.exec(target);
  const held = heldProfiles.get(dir);
  if (held?.target === target && match?.[1] === hostname() && processAlive(Number(match[2])) && processAlive(held.daemon)) return;
  heldProfiles.delete(dir);
  const table = await processTable(true);
  if (!table) return;
  const browsers = [...table].filter(([, entry]) => !entry.zombie && namesProfile(entry.args ?? "", dir) && !/(?:^|\s)--type=/.test(entry.args ?? ""));
  for (const [pid, entry] of browsers) {
    const daemon = await daemonOf(pid, table);
    if (daemon !== null) { heldProfiles.set(dir, { target, daemon }); return; }
    if (!await stopBrowserProcesses({ daemon: pid, members: new Map([[pid, entry.started]]), groups: entry.pgid === pid ? [pid] : [] })) return;
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) { try { unlinkSync(join(dir, name)); } catch {} }
}

function stillRuns(tree: BrowserProcessTree, table: Map<number, ListedProcess>, pid: number): boolean {
  const entry = table.get(pid);
  return !!entry && !entry.zombie && entry.started === tree.members.get(pid);
}

/** Linux and macOS never give a new process the number of a group that still has a process, so a group stays the tree's own
 * unless its leader's number now runs another process. */
function survivors(tree: BrowserProcessTree, table: Map<number, ListedProcess>): { pids: number[]; groups: number[] } {
  const same = (pid: number) => table.get(pid)?.started === tree.members.get(pid);
  const groups = tree.groups.filter((group) => !table.has(group) || same(group));
  const pids = [...table].filter(([pid, entry]) => !entry.zombie && ((tree.members.has(pid) && same(pid)) || groups.includes(entry.pgid))).map(([pid]) => pid);
  return { pids, groups: groups.filter((group) => pids.some((pid) => table.get(pid)!.pgid === group)) };
}

/** Windows soon gives a freed pid to a new process, which is never counted or killed as the daemon. */
async function windowsDaemonRuns(tree: BrowserProcessTree): Promise<boolean | null> {
  const image = await imageOf(tree.daemon);
  return image === null ? null : !!image && image === tree.image;
}

export async function browserProcessesRunning(tree: BrowserProcessTree): Promise<boolean> {
  if (process.platform === "win32") return await windowsDaemonRuns(tree) ?? processAlive(tree.daemon);
  const table = await processTable();
  if (!table) return [...tree.members.keys()].some(processAlive);
  return survivors(tree, table).pids.length > 0;
}

async function within(ms: number, done: () => Promise<boolean>): Promise<boolean> {
  for (const until = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (await done()) return true;
    if (Date.now() >= until) return false;
  }
}

/** The root gets TERM first, alone: the daemon saves sign-ins over its Chrome's DevTools connection, so Chrome must still run
 * (CONT wakes a stopped daemon). Past `graceMs` the tree is killed by process group. */
export async function stopBrowserProcesses(tree: BrowserProcessTree, graceMs = 1_500): Promise<boolean> {
  if (process.platform === "win32") {
    // /T takes the daemon's Chrome too; only a pid still running the daemon's image is named.
    if (await windowsDaemonRuns(tree)) await execText("taskkill", ["/PID", String(tree.daemon), "/T", "/F"]);
    return within(2_000, async () => await windowsDaemonRuns(tree) === false);
  }
  const send = (target: number, signal: NodeJS.Signals) => { try { process.kill(target, signal); } catch {} };
  const rootRuns = async () => {
    const table = await processTable();
    return table ? stillRuns(tree, table, tree.daemon) : processAlive(tree.daemon);
  };
  if (await rootRuns()) {
    send(tree.daemon, "SIGTERM");
    send(tree.daemon, "SIGCONT");
    await within(graceMs, async () => !await rootRuns());
  }
  let gone = false;
  for (let pass = 0; pass < 2 && !gone; pass++) {
    const table = await processTable();
    if (!table) {
      for (const pid of tree.members.keys()) send(pid, "SIGKILL");
    } else {
      const left = survivors(tree, table);
      if (!left.pids.length) { gone = true; break; }
      for (const group of left.groups) send(-group, "SIGKILL");
      for (const pid of left.pids) if (!left.groups.includes(table.get(pid)!.pgid)) send(pid, "SIGKILL");
    }
    gone = await within(1_000, async () => !await browserProcessesRunning(tree));
  }
  if (gone) for (const dir of tree.profiles ?? []) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  return gone;
}
