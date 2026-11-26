// Which cache folders a live process uses (Linux's /proc). Only the server's own descendants are looked at: every bot
// process is one (a box is the server's child, and `--unshare-pid` with `--die-with-parent` keeps whatever a bot starts,
// even a daemon, inside that box's tree), so a process the server did not start cannot be a bot's. A descendant whose
// working folder, program, root, open files, mapped files or environment (a tool cache variable, PATH, VIRTUAL_ENV, …)
// names a path in a root uses it. A boxed bot's every process carries its HOME's tool cache variables
// (bot-box/tool-caches.ts), so any process a bot of that HOME started counts. The sweeper deletes in a root only when none
// does (sweeper.ts). A descendant it cannot read counts as using every root: then nothing is deleted.
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "";
const gone = (error: unknown) => code(error) === "ENOENT" || code(error) === "ESRCH";
const names = (path: string) => (value: string) => value === path || value.startsWith(`${path}/`);

/** The parent of each process, from /proc/<pid>/stat (readable for every process). */
async function parents(proc: string, pids: readonly string[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const pid of pids) {
    const stat = await readFile(join(proc, pid, "stat"), "utf8").catch(() => "");
    // "pid (name, which may hold spaces or parentheses) state ppid …"
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1]);
    if (Number.isInteger(ppid)) map.set(Number(pid), ppid);
  }
  return map;
}

/** The descendants of `self` among `parent`. */
function descendants(parent: ReadonlyMap<number, number>, self: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parent) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const found = new Set<number>(), queue = [...(children.get(self) ?? [])];
  while (queue.length) {
    const pid = queue.pop()!;
    if (found.has(pid) || pid === self) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...found];
}

/** The roots of `roots` that a descendant of `self` uses. `proc` is /proc (a test passes a folder shaped like it). */
export async function rootsInUse(roots: readonly string[], options: { proc?: string; self?: number; unreadable?: (pid: number) => void; using?: (pid: number, root: string) => void } = {}): Promise<Set<string>> {
  const proc = options.proc ?? "/proc", self = options.self ?? process.pid;
  const used = new Set<string>();
  let pids: string[];
  try { pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name)); } catch { return new Set(roots); }
  for (const pid of descendants(await parents(proc, pids), self)) {
    if (used.size === roots.length) break;
    const dir = join(proc, String(pid));
    try {
      const paths: string[] = [];
      for (const link of ["cwd", "exe", "root"]) paths.push(await readlink(join(dir, link)).catch((error: unknown) => { if (gone(error)) return ""; throw error; }));
      const fds = await readdir(join(dir, "fd")).catch((error: unknown) => { if (gone(error)) return [] as string[]; throw error; });
      for (const fd of fds) paths.push(await readlink(join(dir, "fd", fd)).catch(() => ""));
      const maps = await readFile(join(dir, "maps"), "utf8").catch((error: unknown) => { if (gone(error)) return ""; throw error; });
      for (const line of maps.split("\n")) { const at = line.indexOf("/"); if (at >= 0) paths.push(line.slice(at).replace(/ \(deleted\)$/, "")); }
      const environ = await readFile(join(dir, "environ"), "utf8").catch((error: unknown) => { if (gone(error)) return ""; throw error; });
      for (const entry of environ.split("\0")) { const at = entry.indexOf("="); if (at > 0) paths.push(...entry.slice(at + 1).split(":")); }
      for (const root of roots) if (!used.has(root) && paths.some(names(root))) { used.add(root); options.using?.(pid, root); }
    } catch (error) {
      if (gone(error)) continue;
      // The server's own descendant, and it cannot be read: it may be using any of them.
      options.unreadable?.(pid);
      return new Set(roots);
    }
  }
  return used;
}
