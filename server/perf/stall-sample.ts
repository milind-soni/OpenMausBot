// What a stall record holds (stall-watch.ts), and the pure parts of taking one: code locations from a CPU profile of the
// server's main thread, the main thread's state from /proc, the machine's memory and CPU pressure, and the memory each
// kind of process holds. Numbers, kinds and code locations only: never a value, a path outside the app, a name or a word.
import type { ProcessBucket } from "./process-buckets.ts";

/** One frame of a V8 CPU profile node, as the inspector's Profiler domain gives it. */
export interface ProfileFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }
export interface ProfileNode { id: number; callFrame: ProfileFrame; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; samples?: number[] }

/** Where in the code the main thread was, and how many of the profile's samples were there. */
export interface StallFrame { at: string; samples: number }

export interface StallRecord {
  /** When the record was taken, and since when the main thread had not run its heartbeat. */
  at: number;
  blockedSinceMs: number;
  /** "js": the profile answered, and `top` and `stack` say where; "outside-js": it did not answer in time (a system call,
   * a page fault, native code), and the thread's state and the machine's pressure are all there is; "not-profiled": no
   * profile was tried (`why`). */
  kind: "js" | "outside-js" | "not-profiled";
  /** Why no profile: memory too short for one, the hour's profiles taken, no inspector in this Node, or still to come (the
   * record saved before its profile). */
  why?: "memory" | "hourly-cap" | "no-inspector" | "pending";
  /** The frames with the most samples of their own, most first. */
  top: StallFrame[];
  /** The path from the outermost frame to the busiest leaf, outermost first. */
  stack: string[];
  /** The main thread's state letter (R running, D waiting on the disk or a page, S sleeping) and kernel wait channel. */
  thread: { state: string | null; wchan: string | null };
  /** MemAvailable and the memory stall (`full avg10`, percent), the CPU stall (`some avg10`) and steal over the last second. */
  machine: { availableMB: number | null; memoryFull10: number | null; cpuSome10: number | null; stealPct: number | null };
  /** Memory by kind of process, most first (perf/process-buckets.ts kinds). */
  memory: Array<{ bucket: ProcessBucket; rssMB: number; procs: number }>;
}

const SAFE_NAME = /^[\w$.<>[\] -]{1,80}$/;

/** A code location with nothing of the machine's paths: the file's place in the app (its path under `appRoot`, the
 * app's own folder), a package's name and path, a Node built-in, or only its base name. */
export function codeLocation(frame: ProfileFrame, appRoot = ""): string {
  const pseudo = /^\([a-z ]{1,40}\)$/.test(frame.functionName);
  const name = frame.functionName && (pseudo || SAFE_NAME.test(frame.functionName)) ? frame.functionName : "(anonymous)";
  if (!frame.url) return name;
  // `file:///C:/x` and `C:\x` alike: forward slashes, no slash before a drive letter, which compares in either case.
  const normal = (text: string) => text.replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1").replace(/^([A-Za-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  const raw = frame.url.replace(/^file:\/\//, "").split("?")[0]!;
  let decoded = raw;
  try { decoded = decodeURI(raw); } catch {}
  const path = normal(decoded);
  const root = normal(appRoot).replace(/\/?$/, "/");
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+\/.*)$/.exec(path)?.[1];
  const app = !pkg && root !== "/" && path.startsWith(root) ? path.slice(root.length) : undefined;
  const builtin = /^node:[\w/]+$/.test(path) ? path : null;
  const file = (builtin ?? pkg ?? app ?? path.split("/").pop() ?? "?").replace(/[^\w@./:-]/g, "_").slice(0, 120);
  return frame.lineNumber >= 0 ? `${name} ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : `${name} ${file}`;
}

/** The busiest frames by own samples, and the stack to the busiest leaf. Idle and garbage-collection pseudo-frames count
 * as themselves: a stall that is mostly `(garbage collector)` says so. */
export function summarizeProfile(profile: CpuProfile, appRoot = "", topN = 8, depth = 24): { top: StallFrame[]; stack: string[] } {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const own = new Map<number, number>();
  for (const id of profile.samples ?? []) own.set(id, (own.get(id) ?? 0) + 1);
  const byLocation = new Map<string, number>();
  for (const [id, count] of own) {
    const node = byId.get(id);
    if (!node) continue;
    const at = codeLocation(node.callFrame, appRoot);
    byLocation.set(at, (byLocation.get(at) ?? 0) + count);
  }
  const top = [...byLocation].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([at, samples]) => ({ at, samples }));
  const busiest = [...own].filter(([id]) => !/^\((idle|program|root)\)$/.test(byId.get(id)?.callFrame.functionName ?? "")).sort((a, b) => b[1] - a[1])[0]?.[0];
  const stack: string[] = [];
  for (let id: number | undefined = busiest; id !== undefined && stack.length < depth; id = parent.get(id)) {
    const node = byId.get(id);
    if (!node || node.callFrame.functionName === "(root)") break;
    stack.push(codeLocation(node.callFrame, appRoot));
  }
  return { top, stack: stack.reverse() };
}

/** The state letter and wait channel of a thread from /proc/<pid>/task/<tid>/stat and .../wchan. */
export function threadState(stat: string | null, wchan: string | null): { state: string | null; wchan: string | null } {
  const state = stat ? /\)\s+([A-Za-z])\s/.exec(stat)?.[1] ?? null : null;
  const channel = wchan && /^[\w.]{1,64}$/.test(wchan.trim()) && wchan.trim() !== "0" ? wchan.trim() : null;
  return { state, wchan: channel };
}

/** MemAvailable from /proc/meminfo, MB. */
export function availableMB(meminfo: string | null): number | null {
  const found = meminfo ? /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo) : null;
  return found ? Math.round(Number(found[1]) / 1024) : null;
}

/** A pressure file's `some` or `full` avg10, percent. */
export function pressure10(text: string | null, line: "some" | "full"): number | null {
  const found = text ? new RegExp(`^${line} avg10=([\\d.]+)`, "m").exec(text) : null;
  return found ? Number(found[1]) : null;
}

/** The share of all CPU time that was stolen between two reads of /proc/stat's first line, percent. */
export function stealPercent(before: string | null, after: string | null): number | null {
  const fields = (text: string | null) => text ? /^cpu\s+(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number) ?? null : null;
  const a = fields(before), b = fields(after);
  if (!a || !b || a.length < 8 || b.length < 8) return null;
  const total = b.reduce((sum, value, index) => sum + value - (a[index] ?? 0), 0);
  return total > 0 ? Math.round(((b[7]! - a[7]!) / total) * 1000) / 10 : null;
}

/** One line for the server log, and for a report. */
export function stallLine(record: StallRecord): string {
  const blocked = Math.round(record.blockedSinceMs / 1000);
  const state = `thread state ${record.thread.state ?? "?"}${record.thread.wchan ? `, waiting in ${record.thread.wchan}` : ""}`;
  const why = { memory: "memory too short to profile", "hourly-cap": "the hour's profiles taken", "no-inspector": "no inspector here", pending: "profile to follow" };
  const where = record.kind === "js"
    ? `in JavaScript: ${record.top.slice(0, 3).map((frame) => `${frame.at} (${frame.samples})`).join("; ") || "no samples"}${record.stack.length ? `; stack ${record.stack.slice(-8).join(" > ")}` : ""}`
    : record.kind === "outside-js" ? `outside JavaScript (${state})` : `not profiled, ${why[record.why ?? "pending"]} (${state})`;
  const m = record.machine, num = (value: number | null, unit = "") => value === null ? "?" : `${value}${unit}`;
  const memory = record.memory.slice(0, 4).map((entry) => `${entry.bucket} ${entry.rssMB} MB`).join(", ");
  return `main thread blocked ${blocked}s, ${where}; memory available ${num(m.availableMB, " MB")}, memory stall ${num(m.memoryFull10, "%")}, `
    + `cpu stall ${num(m.cpuSome10, "%")}, steal ${num(m.stealPct, "%")}${memory ? `; largest: ${memory}` : ""}`;
}
