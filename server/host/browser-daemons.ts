// Which process a bot's agent-browser daemon is, for the per-bot footprint (perf/bot-footprint.ts) and what counts from it.
// A session's pid file lives in the data folder, which on a Cloud is a volume that outlives the machine: after an OOM kill
// or a stop, the pid it names may be tini, the supervisor, this server or anything else, and everything under it would
// count as that bot's browser. So a pid counts only once it is checked to run agent-browser's daemon for that session (the
// binary's path, AGENT_BROWSER_DAEMON=1 and the session's name in its environment, as browser-processes.ts checks before
// a close), never this server or one of its ancestors, and the check is kept with the pid's start time: a pid the system
// has since given to another process is checked again. Linux reads /proc (no spawn, so the sampler and the memory
// watchdog can ask synchronously); elsewhere `ps` is asked in the background and a session counts from the next sample.
import { readFileSync } from "node:fs";

import { browserDaemonRuns, daemonPaths, environmentEntries, isBrowserDaemon } from "../browser-processes.ts";

type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

/** A pid's start tick and parent from its /proc stat line (the fields after the command's last ')'). */
function statOf(pid: number, read: Read): { start: string; ppid: number } | null {
  const text = read(`/proc/${pid}/stat`);
  if (!text) return null;
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const start = fields[19], ppid = Number(fields[1]);
  return start && Number.isInteger(ppid) ? { start, ppid } : null;
}

/** This server and every process above it, up to init: never a bot's browser, whatever a pid file says. */
function serverLine(platform: NodeJS.Platform, read: Read, self: number, parent: number): Set<number> {
  const line = new Set([1, self, parent]);
  if (platform !== "linux") return line;
  for (let pid = parent, depth = 0; pid > 1 && depth < 32; depth++) {
    line.add(pid);
    const next = statOf(pid, read)?.ppid;
    if (next === undefined || next === pid) break;
    pid = next;
  }
  return line;
}

export interface BrowserDaemonsOptions {
  platform?: NodeJS.Platform;
  read?: Read;
  /** Elsewhere than Linux: whether the pid runs the session's daemon now (browser-processes.ts browserDaemonRuns). */
  check?: (binaryPath: string, pid: number, session: string) => Promise<boolean>;
  self?: number;
  parent?: number;
  now?: () => number;
}

/** How long a check stands where no start time tells a pid's processes apart (macOS): it is made again in the background. */
const RECHECK_MS = 60_000;
const MAX_SESSIONS = 1_024;

export function createBrowserDaemons(options: BrowserDaemonsOptions = {}) {
  const platform = options.platform ?? process.platform, read = options.read ?? readText, now = options.now ?? Date.now;
  const check = options.check ?? browserDaemonRuns;
  let excluded: Set<number> | null = null;
  const server = () => (excluded ??= serverLine(platform, read, options.self ?? process.pid, options.parent ?? process.ppid));
  /** By session: the pid checked, its start (Linux) or when it was checked (elsewhere), and whether it was the daemon. */
  const checked = new Map<string, { pid: number; start: string | null; at: number; daemon: boolean }>();
  const pending = new Set<string>();
  const remember = (session: string, entry: { pid: number; start: string | null; at: number; daemon: boolean }) => {
    checked.delete(session);
    checked.set(session, entry);
    if (checked.size > MAX_SESSIONS) checked.delete(checked.keys().next().value!);
  };

  return {
    /** The daemon `pid` (read from `session`'s pid file) where it is checked to be that session's agent-browser daemon:
     * with its start time on Linux, so a list that shows the pid with another start does not count it either. */
    owner(binaryPath: string, session: string, pid: number): { pid: number; start?: string } | null {
      if (!Number.isInteger(pid) || pid <= 1 || server().has(pid)) return null;
      const known = checked.get(session);
      if (platform === "linux") {
        const stat = statOf(pid, read);
        if (!stat) return null;
        if (known?.pid === pid && known.start === stat.start) return known.daemon ? { pid, start: stat.start } : null;
        const command = read(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean).join(" ") || null;
        const environ = read(`/proc/${pid}/environ`);
        const daemon = isBrowserDaemon(daemonPaths(binaryPath), command, environ === null ? null : environmentEntries(environ.split("\0")), session)
          // Read again: the pid was not given to another process while its files were read.
          && statOf(pid, read)?.start === stat.start;
        remember(session, { pid, start: stat.start, at: now(), daemon });
        return daemon ? { pid, start: stat.start } : null;
      }
      if (platform === "win32") return null;
      const fresh = known?.pid === pid && now() - known.at < RECHECK_MS;
      if (!fresh && !pending.has(session)) {
        pending.add(session);
        void check(binaryPath, pid, session).catch(() => false)
          .then((daemon) => remember(session, { pid, start: null, at: now(), daemon }))
          .finally(() => pending.delete(session));
      }
      return known?.pid === pid && known.daemon ? { pid } : null;
    },
  };
}
export type BrowserDaemons = ReturnType<typeof createBrowserDaemons>;
