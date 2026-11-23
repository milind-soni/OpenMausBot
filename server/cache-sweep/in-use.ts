// Which cache folders a live process uses (Linux's /proc): a process of this server's user whose working folder, program,
// root, open files, mapped files or environment (a tool cache variable, PATH, VIRTUAL_ENV, …) names a path in one. A
// boxed bot's every process carries its HOME's tool cache variables (bot-box/tool-caches.ts), so any process a bot of that
// HOME started counts. The sweeper deletes in a folder only when none does (sweeper.ts). A process it cannot read counts
// as using every folder: then nothing is deleted.
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "";
const gone = (error: unknown) => code(error) === "ENOENT" || code(error) === "ESRCH";
const names = (path: string) => (value: string) => value === path || value.startsWith(`${path}/`);

/** The roots of `roots` that a process other than `self` uses. `proc` is /proc (a test passes a folder shaped like it). */
export async function rootsInUse(roots: readonly string[], options: { proc?: string; self?: number; uid?: number | null; unreadable?: (pid: number) => void; using?: (pid: number, root: string) => void } = {}): Promise<Set<string>> {
  const proc = options.proc ?? "/proc", self = options.self ?? process.pid;
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const used = new Set<string>();
  let pids: string[];
  try { pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name) && Number(name) !== self); } catch { return new Set(roots); }
  for (const pid of pids) {
    if (used.size === roots.length) break;
    const dir = join(proc, pid);
    try {
      // Only this user's processes: a bot's run as the server's user (inside its own user namespace).
      if (uid !== null && Number((await lstat(dir)).uid) !== uid) continue;
      const paths: string[] = [];
      for (const link of ["cwd", "exe", "root"]) paths.push(await readlink(join(dir, link)).catch((error: unknown) => { if (gone(error)) return ""; throw error; }));
      const fds = await readdir(join(dir, "fd")).catch((error: unknown) => { if (gone(error)) return [] as string[]; throw error; });
      for (const fd of fds) paths.push(await readlink(join(dir, "fd", fd)).catch(() => ""));
      const maps = await readFile(join(dir, "maps"), "utf8").catch((error: unknown) => { if (gone(error)) return ""; throw error; });
      for (const line of maps.split("\n")) { const at = line.indexOf("/"); if (at >= 0) paths.push(line.slice(at).replace(/ \(deleted\)$/, "")); }
      const environ = await readFile(join(dir, "environ"), "utf8").catch((error: unknown) => { if (gone(error)) return ""; throw error; });
      for (const entry of environ.split("\0")) { const at = entry.indexOf("="); if (at > 0) paths.push(...entry.slice(at + 1).split(":")); }
      for (const root of roots) if (!used.has(root) && paths.some(names(root))) { used.add(root); options.using?.(Number(pid), root); }
    } catch (error) {
      if (gone(error)) continue;
      // This user's process, and it cannot be read: it may be using any of them.
      options.unreadable?.(Number(pid));
      return new Set(roots);
    }
  }
  return used;
}
