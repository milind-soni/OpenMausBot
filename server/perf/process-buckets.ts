// Which part of a home a process belongs to, from its executable's name and its parent alone. Privacy invariant: the name
// is read, matched against fixed lists and dropped; only the bucket leaves this file. Never an argument, a path, an
// environment value or the name itself.

export type ProcessBucket = "server" | `engine:${string}` | "browser" | "computer" | "mcp" | "build" | "commands" | "other";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The executable's base name, lower-cased: the kernel's 15-character `comm` on Linux. */
  name: string;
  /** User plus system CPU time so far, ms. */
  cpuMs: number;
  rssBytes: number;
  /** Tells a pid apart from an earlier process that had it (its start time, as the source gives it). */
  start: string;
  /** Linux: the process's threads, and its state letter ("Z": exited, not yet collected). */
  threads?: number;
  state?: string;
  /** Its process group (Linux and macOS) and POSIX session (Linux): an engine leads both, and what it starts stays in them
   * even once its parent has gone. */
  pgid?: number;
  sid?: number;
}

/** Engine CLIs by executable name, as the drivers' kinds name them. */
const ENGINE_NAMES: Readonly<Record<string, string>> = {
  claude: "claudeAgent", codex: "codex", opencode: "opencodeGo", grok: "grokAgent", gemini: "geminiAgent", kimi: "kimiAgent",
  droid: "droidAgent", "cursor-agent": "cursorAgent", qwen: "qwenAgent", hermes: "hermesAgent", cline: "clineAgent",
  copilot: "copilotAgent", kiro: "kiroAgent", "kiro-cli": "kiroAgent", devin: "devinAgent", pi: "piAgent", omp: "ompAgent",
  vibe: "mistralVibeAgent", antigravity: "antigravityAgent", goose: "gooseAgent",
};
const BROWSER_PREFIXES = ["chrom", "google chrome", "headless_shell", "chrome-headless", "camoufox", "firefox", "msedge", "microsoft edge"];
const COMPUTER_NAMES = new Set(["xvfb", "xvnc", "x11vnc", "websockify", "vncserver", "novnc", "ssh", "sshpass", "xdotool", "ffmpeg", "xfce4-session", "xfwm4"]);
const COMPUTER_PREFIXES = ["tigervnc", "qemu-system", "cua"];
const BUILD_NAMES = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "cargo", "rustc", "go", "make", "cmake", "ninja", "gcc", "g++", "cc", "cc1",
  "cc1plus", "clang", "clang++", "ld", "collect2", "as", "tsc", "esbuild", "vite", "webpack", "node-gyp", "git", "apt", "apt-get", "dpkg", "gradle", "mvn"]);
/** What an MCP server runs as when an engine (or the server, for a chat-runtime turn) starts it. */
const RUNTIMES = new Set(["node", "npx", "npm exec", "uv", "uvx", "python", "python3", "bun", "deno", "docker", "java"]);
const RUNTIME_PREFIXES = ["python3."];

export function nameBucket(name: string): ProcessBucket | null {
  if (Object.hasOwn(ENGINE_NAMES, name)) return `engine:${ENGINE_NAMES[name]!}`;
  if (BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix))) return "browser";
  if (COMPUTER_NAMES.has(name) || COMPUTER_PREFIXES.some((prefix) => name.startsWith(prefix))) return "computer";
  if (BUILD_NAMES.has(name)) return "build";
  return null;
}

const runtime = (name: string) => RUNTIMES.has(name) || RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix));
const INHERITED: ReadonlySet<ProcessBucket> = new Set(["browser", "computer", "mcp", "build", "commands"]);

const ENGINE_KIND = /^[A-Za-z][A-Za-z0-9-]{0,47}$/;

/**
 * Every row's bucket. A pid the server knows runs an engine is that engine, whatever its executable (an engine started
 * through `node`); a row named on a list is that; a runtime an engine or the server started is an MCP server; anything
 * else under an engine or the server is a command a bot ran; below those, a row takes its parent's. With `treeOnly`,
 * rows that do not descend from the server are left out.
 */
export function classifyProcesses(rows: readonly ProcessRow[], serverPid: number, treeOnly: boolean, engines: ReadonlyMap<number, string> = new Map()): Map<number, ProcessBucket> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const out = new Map<number, ProcessBucket | null>();
  const visit = (row: ProcessRow, depth: number): ProcessBucket | null => {
    const known = out.get(row.pid);
    if (known !== undefined) return known;
    let bucket: ProcessBucket | null;
    if (row.pid === serverPid) bucket = "server";
    else {
      const parent = row.ppid !== row.pid && depth < 64 ? byPid.get(row.ppid) : undefined;
      const above = parent ? visit(parent, depth + 1) : null;
      const engineKind = engines.get(row.pid);
      const named: ProcessBucket | null = engineKind !== undefined ? `engine:${ENGINE_KIND.test(engineKind) ? engineKind : "unknown"}` : nameBucket(row.name);
      if (treeOnly && above === null) bucket = null;
      else if (named) bucket = named;
      else if (above === "server" || above?.startsWith("engine:")) bucket = runtime(row.name) ? "mcp" : "commands";
      else if (above && INHERITED.has(above)) bucket = above;
      else bucket = "other";
    }
    out.set(row.pid, bucket);
    return bucket;
  };
  for (const row of rows) visit(row, 0);
  return new Map([...out].filter((entry): entry is [number, ProcessBucket] => entry[1] !== null));
}

const CLOCK_TICKS = 100, PAGE_BYTES = 4096;

/** One `/proc/<pid>/stat` line: comm may hold spaces and parentheses, so fields count from its last ")". */
export function parseProcStat(pid: number, text: string): ProcessRow | null {
  const open = text.indexOf("("), close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]), user = Number(fields[11]), system = Number(fields[12]), start = fields[19], rss = Number(fields[21]);
  if (!Number.isInteger(ppid) || !Number.isFinite(user) || !Number.isFinite(system) || !start) return null;
  const threads = Number(fields[17]), pgid = Number(fields[2]), sid = Number(fields[3]);
  return { pid, ppid, name: text.slice(open + 1, close).toLowerCase(), cpuMs: ((user + system) * 1000) / CLOCK_TICKS, rssBytes: (Number.isFinite(rss) ? rss : 0) * PAGE_BYTES, start,
    ...(Number.isInteger(threads) && /^[A-Za-z]$/.test(fields[0] ?? "") ? { threads, state: fields[0]! } : {}),
    ...(Number.isInteger(pgid) && pgid > 0 ? { pgid } : {}), ...(Number.isInteger(sid) && sid > 0 ? { sid } : {}) };
}

/** `/proc/self/stat`'s CPU time of children this process waited for, ms. */
export function parseReapedChildrenMs(text: string): number | null {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const user = Number(fields[13]), system = Number(fields[14]);
  return Number.isFinite(user) && Number.isFinite(system) ? ((user + system) * 1000) / CLOCK_TICKS : null;
}

/** `ps`'s cumulative CPU time: `[[dd-]hh:]mm:ss[.ss]`. */
export function parsePsTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

/** One line of `ps -axo pid=,ppid=,pgid=,rss=,time=,comm=`: rss in KiB, comm the executable's path (macOS), last so it may
 * hold spaces. The older five-column form (no pgid) is read too. */
export function parsePsLine(line: string): ProcessRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)\s+)?(\d+)\s+(\d\S*)\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  const cpuMs = parsePsTime(match[5]!);
  if (cpuMs === null) return null;
  const path = match[6]!;
  const pid = Number(match[1]), pgid = match[3] === undefined ? 0 : Number(match[3]);
  return { pid, ppid: Number(match[2]), name: path.slice(path.lastIndexOf("/") + 1).toLowerCase(), cpuMs, rssBytes: Number(match[4]) * 1024, start: `ps:${pid}`,
    ...(pgid > 0 ? { pgid } : {}) };
}

/** The cgroup's (or, outside one, the machine's) CPU time so far, ms: cgroup v2's usage_usec, else v1's cpuacct.usage. */
export function parseCgroupCpuMs(v2: string | null, v1: string | null): number | null {
  const usec = v2 ? /^usage_usec (\d+)$/m.exec(v2)?.[1] : undefined;
  if (usec !== undefined) return Number(usec) / 1000;
  const nsec = v1?.trim();
  return nsec && /^\d+$/.test(nsec) ? Number(nsec) / 1e6 : null;
}
