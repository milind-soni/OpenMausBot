// The bots' Chrome on a Cloud home runs under a memory limit the kernel enforces, so a browser can never take the memory
// the server needs to keep answering. The server's own guards (memory-ceiling.ts, engine-memory.ts) run on its event
// loop; on a 2 GB home without swap a growing browser left the machine thrashing on its page cache, the server's own code
// was evicted, and nothing that could act ran any more (Nov 2026). Under a cgroup v2 `memory.max` the kernel reclaims and,
// at the limit, kills inside the browsers' group alone: the server, the edge and the engines keep their pages.
//
// The root supervisor (cloud-home-start.ts) makes `<its cgroup>/omb/{server,browsers}`, puts the server in `server` and
// gives `maus` the right to move its own processes between the two (cgroup.procs of `omb` and of both leaves). Each Chrome
// moves itself into `browsers` before it starts: the generated launcher's first line (chrome/wrapper.ts). Anything missing
// (cgroup v1, a read-only cgroup tree, a container whose own cgroup holds its processes, as Docker's does) leaves things
// as they were, with one line in the log saying why. Nothing is moved out of a container's cgroup to make room: that would
// break `docker exec` into it.
import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

/** Read by the root supervisor only: "off" (or 0) for no limit, a number of MB, else the default. */
export const BROWSER_MEMORY_MAX_ENV = "OMB_BROWSER_MEMORY_MAX";
/** Handed by the supervisor to the server: the browsers' cgroup folder, which every bot Chrome joins as it starts. */
export const BROWSER_CGROUP_ENV = "OMB_BROWSER_CGROUP";

const MB = 1_048_576;
/** The browsers together may use this share of the machine: above the ceiling's hard line (half), so the server's own
 * close comes first while it can run, and below what leaves the server, the edge and an engine their room. */
export const BROWSER_MEMORY_SHARE = 0.55;
const FLOOR_BYTES = 900 * MB, SMALLEST_BYTES = 256 * MB, MOST_SHARE = 0.8;

/** The limit for the browsers' group, or null for none: 55% of the memory (at least 900 MB, at most 80%) by default. */
export function browserMemoryMax(env: NodeJS.ProcessEnv, memoryBytes: number, warn: (line: string) => void = () => undefined): number | null {
  const raw = env[BROWSER_MEMORY_MAX_ENV]?.trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  if (raw && /^\d+$/.test(raw)) return Math.max(SMALLEST_BYTES, Number(raw) * MB);
  if (raw && raw !== "auto") warn(`${BROWSER_MEMORY_MAX_ENV}=${JSON.stringify(env[BROWSER_MEMORY_MAX_ENV])} is not a number of MB, "auto" or "off", so the default is used`);
  if (!(memoryBytes > 0)) return null;
  return Math.round(Math.min(memoryBytes * MOST_SHARE, Math.max(FLOOR_BYTES, memoryBytes * BROWSER_MEMORY_SHARE)));
}

/** This process's cgroup folder in the v2 tree, from /proc/self/cgroup's "0::" line; null without one. */
export function ownCgroupDir(procSelfCgroup: string, mount = "/sys/fs/cgroup"): string | null {
  const own = /^0::(\/\S*)$/m.exec(procSelfCgroup)?.[1];
  return own === undefined ? null : own === "/" ? mount : posix.join(mount, own);
}

/** A browsers' cgroup folder the launcher may write to: an absolute path under /sys/fs/cgroup, nothing a shell would read. */
export function browserCgroupDir(value: string | undefined): string | null {
  const dir = value?.trim() ?? "";
  return /^\/sys\/fs\/cgroup(?:\/[A-Za-z0-9_.-]+)+$/.test(dir) && !dir.split("/").includes("..") ? dir : null;
}

export interface CgroupFs {
  read(path: string): string;
  write(path: string, data: string): void;
  mkdir(path: string): void;
  chown(path: string, uid: number, gid: number): void;
}

const realFs: CgroupFs = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => writeFileSync(path, data),
  mkdir: (path) => { try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } },
  chown: chownSync,
};

export interface BrowserCgroup { base: string; server: string; browsers: string; limitBytes: number }
export type BrowserCgroupSetup = { ok: true; group: BrowserCgroup } | { ok: false; why: string };

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
const hasMemory = (list: string) => /(^|\s)memory(\s|$)/.test(list);

/** Root, once at start, before the server runs: the browsers' group under `base` (the supervisor's own cgroup). */
export function setUpBrowserCgroup(options: { base: string; limitBytes: number; ids: { uid: number; gid: number } | null; fs?: CgroupFs }): BrowserCgroupSetup {
  const fs = options.fs ?? realFs, { base } = options;
  let controllers: string;
  try { controllers = fs.read(`${base}/cgroup.controllers`); } catch (error) { return { ok: false, why: `no cgroup v2 tree at ${base} (${code(error)})` }; }
  if (!hasMemory(controllers)) return { ok: false, why: `the memory controller is not offered at ${base}` };
  let enabled = "";
  try { enabled = fs.read(`${base}/cgroup.subtree_control`); } catch {}
  if (!hasMemory(enabled)) {
    try { fs.write(`${base}/cgroup.subtree_control`, "+memory"); } catch (error) {
      return { ok: false, why: code(error) === "EBUSY"
        ? `processes share ${base} (a container's own cgroup), and none are moved out of it`
        : `the memory controller could not be turned on at ${base} (${code(error)})` };
    }
  }
  const root = `${base}/omb`, server = `${root}/server`, browsers = `${root}/browsers`;
  try {
    for (const dir of [root, server, browsers]) fs.mkdir(dir);
    fs.write(`${root}/cgroup.subtree_control`, "+memory");
    fs.write(`${browsers}/memory.max`, String(options.limitBytes));
    // Nor swap beyond it (where swap is counted): at the limit a browser ends rather than pushes the machine into swap.
    try { fs.write(`${browsers}/memory.swap.max`, "0"); } catch {}
    if (options.ids) for (const dir of [root, server, browsers]) fs.chown(`${dir}/cgroup.procs`, options.ids.uid, options.ids.gid);
  } catch (error) {
    return { ok: false, why: `${root} could not be set up (${code(error)})` };
  }
  return { ok: true, group: { base, server, browsers, limitBytes: options.limitBytes } };
}

/** Starts a child in `dir`: this process joins it for the spawn (a child is born in its parent's cgroup), then goes back to
 * `back`. Where it can't join, the child starts where this process is. */
export function spawnInCgroup<T>(dir: string, back: string, spawn: () => T, fs: Pick<CgroupFs, "write"> = realFs): T {
  try { fs.write(`${dir}/cgroup.procs`, String(process.pid)); } catch { return spawn(); }
  try { return spawn(); } finally { try { fs.write(`${back}/cgroup.procs`, String(process.pid)); } catch {} }
}

/** The kernel's count of processes it killed at the group's limit (memory.events), or null where it can't be read. */
export function groupOomKills(dir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  try {
    const found = /^oom_kill (\d+)$/m.exec(read(`${dir}/memory.events`));
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

/** The supervisor's part: the limit from its environment and the machine's memory, the group set up, and one line for the
 * log either way, with how long it took. */
export function prepareBrowserCgroup(env: NodeJS.ProcessEnv, memoryBytes: number, ids: { uid: number; gid: number } | null,
  deps: { fs?: CgroupFs; procSelfCgroup?: () => string; now?: () => number } = {}): { group: BrowserCgroup | null; line: string } {
  const now = deps.now ?? (() => performance.now()), started = now();
  const warnings: string[] = [];
  const limit = browserMemoryMax(env, memoryBytes, (line) => warnings.push(line));
  const lead = `browser memory limit${warnings.length ? ` (${warnings.join("; ")})` : ""}`;
  if (limit === null) return { group: null, line: `${lead}: off (${BROWSER_MEMORY_MAX_ENV}=${env[BROWSER_MEMORY_MAX_ENV] ?? ""})` };
  let own: string | null = null;
  try { own = ownCgroupDir((deps.procSelfCgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))()); } catch {}
  if (own === null) return { group: null, line: `${lead}: not set (this process is in no cgroup v2)` };
  const setup = setUpBrowserCgroup({ base: own, limitBytes: limit, ids, ...(deps.fs ? { fs: deps.fs } : {}) });
  const took = `${(now() - started).toFixed(1)} ms`;
  return setup.ok
    ? { group: setup.group, line: `${lead}: ${Math.round(limit / MB)} MB for the bots' Chrome, in ${setup.group.browsers} (set up in ${took})` }
    : { group: null, line: `${lead}: not set, ${setup.why} (${took})` };
}

/** Moves into the group each of these processes that is not in it yet (a Chrome started outside the launcher, or before
 * the limit), reading /proc/<pid>/cgroup first: a move takes a lock every fork on the machine waits on, so a process
 * already there is never moved again. How many moved. */
export function containInGroup(dir: string, pids: readonly number[], fs: Pick<CgroupFs, "read" | "write"> = realFs, mount = "/sys/fs/cgroup"): number {
  const inside = dir.startsWith(`${mount}/`) ? dir.slice(mount.length) : null;
  if (inside === null) return 0;
  let moved = 0;
  for (const pid of pids) {
    let own: string;
    try { own = /^0::(\/\S*)$/m.exec(fs.read(`/proc/${pid}/cgroup`))?.[1] ?? ""; } catch { continue; }
    if (!own || own === inside || own.startsWith(`${inside}/`)) continue;
    try { fs.write(`${dir}/cgroup.procs`, String(pid)); moved += 1; } catch {}
  }
  return moved;
}
