import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** `start` tells a process from a later one that reuses its pid: the kernel's start tick on Linux, ps's lstart elsewhere. */
export interface TreeProcess {
  pid: number;
  start: string;
}

type Row = TreeProcess & { parent: number; gone: boolean };

function linuxRows(): Row[] {
  const rows: Row[] = [];
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return rows; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(entry), parent: Number(fields[1]), start: fields[19] ?? "", gone: fields[0] === "Z" || fields[0] === "X" });
    } catch {}
  }
  return rows;
}

/** macOS keeps ps at /bin/ps, and the C locale keeps lstart in one fixed form. */
function psRows(): Row[] {
  let listing: string;
  try {
    listing = execFileSync(process.platform === "darwin" ? "/bin/ps" : "ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return []; }
  const rows: Row[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), parent: Number(match[2]), start: match[4]!, gone: match[3]!.startsWith("Z") });
  }
  return rows;
}

function rows(platform: NodeJS.Platform): Row[] {
  return platform === "linux" ? linuxRows() : platform === "win32" ? [] : psRows();
}

/** The live processes below `root`, parents before their children. Empty on Windows, where taskkill /T walks the tree. */
export function descendantsOf(root: number, platform: NodeJS.Platform = process.platform): TreeProcess[] {
  const all = rows(platform);
  const found: TreeProcess[] = [];
  const parents = [root];
  for (let next = 0; next < parents.length; next += 1) {
    for (const row of all) {
      if (row.parent !== parents[next] || row.pid === process.pid || row.pid <= 1 || parents.includes(row.pid)) continue;
      parents.push(row.pid);
      if (!row.gone) found.push({ pid: row.pid, start: row.start });
    }
  }
  return found;
}

/** Those of `tree` still running as the same process. */
export function stillRunning(tree: readonly TreeProcess[], platform: NodeJS.Platform = process.platform): TreeProcess[] {
  if (!tree.length) return [];
  const now = new Map(rows(platform).filter((row) => !row.gone).map((row) => [row.pid, row.start]));
  return tree.filter((one) => now.get(one.pid) === one.start);
}

export function signalTree(tree: readonly TreeProcess[], signal: NodeJS.Signals): void {
  for (const one of [...tree].reverse()) {
    if (one.pid <= 1 || one.pid === process.pid) continue;
    try { process.kill(one.pid, signal); } catch {}
  }
}

/** SIGTERM to every process of `tree`, SIGKILL to those still there after `graceMs`. Resolves once none is left or the kill was sent. */
export async function stopTree(tree: readonly TreeProcess[], graceMs: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  let left = stillRunning(tree, platform);
  if (!left.length) return;
  signalTree(left, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, platform === "linux" ? 50 : 250));
    left = stillRunning(left, platform);
    if (!left.length) return;
  }
  signalTree(left, "SIGKILL");
}
