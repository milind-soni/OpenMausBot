// What an ACP agent is doing while it sends nothing.
//
// ACP has no "still working" message, and agents go quiet for minutes in
// normal work: Qwen Code 0.24 says nothing over the wire while it waits out
// a rate limit, while its SDK retries a request, or while one slow model
// call runs. Silence alone cannot tell that from a wedged process, so a
// quiet turn is probed from outside: the agent's own debug log where it
// keeps one, and the process tree's open connections and CPU time. The
// result becomes a plain-words notice in the chat, so the person is never
// left watching a spinner without knowing why.

import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** One fact an agent's debug log states about what it is doing. */
export type LogSignal =
  | { kind: "retry"; status: number | null; delayMs: number | null; attempt: number | null }
  | { kind: "compressing" }
  /** history size against the auto-compression threshold, from the
   * cheap gate's NOOP line: a near-full history is likely compressed next */
  | { kind: "context"; tokens: number; threshold: number };

export type QuietState =
  | { kind: "retrying"; status: number | null; delayMs: number | null; attempt: number | null }
  | { kind: "compressing" }
  | { kind: "waiting-model"; nearFullContext: boolean }
  | { kind: "busy" }
  /** no connection, no CPU, briefly: an SDK sleeping between retries
   * looks exactly like this, so it is not called stuck yet */
  | { kind: "between-requests" }
  | { kind: "no-signs" }
  | { kind: "unknown" };

export interface ProcessSample {
  /** CPU time of the whole tree, or null when it could not be read */
  cpuMs: number | null;
  /** established TCP connections held by the tree, or null when unknown */
  connections: number | null;
}

/** Qwen Code's debug log (QWEN_DEBUG_LOG_FILE=1), lines like
 *  `2026-10-02T02:50:41.757Z [WARN] [RETRY] Attempt 1 failed with status 429. Retrying after explicit delay of 20000ms...`.
 *  Only the facts worth telling a person are parsed; every other line still
 *  counts as proof the process is alive. */
export function parseQwenLogLine(line: string): LogSignal | null {
  if (line.includes("[RETRY]") && /\bAttempt \d+ failed\b/.test(line)) {
    const attempt = /\bAttempt (\d+) failed/.exec(line);
    const status = /\bwith status (\d{3})\b/.exec(line);
    const explicit = /explicit delay of (\d+)\s*ms/.exec(line);
    const seconds = /Retrying in (\d+)\s*s\b/.exec(line);
    return {
      kind: "retry",
      attempt: attempt ? Number(attempt[1]) : null,
      status: status ? Number(status[1]) : null,
      delayMs: explicit ? Number(explicit[1]) : seconds ? Number(seconds[1]) * 1000 : null,
    };
  }
  if (/\[compaction\] hard-tier rescue triggered|Reactive compression|tryCompress/.test(line)
      && !/succeeded|failed|skipped|stopped/.test(line)) {
    return { kind: "compressing" };
  }
  const gate = /\[compaction\] cheap-gate NOOP: effectiveTokens=(\d+), auto=(\d+)/.exec(line);
  if (gate) return { kind: "context", tokens: Number(gate[1]), threshold: Number(gate[2]) };
  return null;
}

/** Reads the lines appended to a log file since the last read. A file that
 *  does not exist yet is simply empty; the first read skips what was already
 *  there, so an old conversation's log is not replayed as news. */
export class LogTail {
  private offset: number | null = null;
  private partial = "";
  private readonly path: string;
  private readonly maxBytes: number;
  constructor(path: string, maxBytes = 256 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  read(): string[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      if (this.offset === null) this.offset = 0;
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (this.offset === null) {
        this.offset = size;
        return [];
      }
      // truncated or replaced: start over from its beginning
      if (size < this.offset) { this.offset = 0; this.partial = ""; }
      if (size === this.offset) return [];
      // a burst bigger than the cap keeps only its tail
      const start = Math.max(this.offset, size - this.maxBytes);
      if (start > this.offset) this.partial = "";
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      this.offset = size;
      const text = this.partial + buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      this.partial = lines.pop() ?? "";
      return lines.filter((l) => l.trim());
    } catch {
      return [];
    } finally {
      try { closeSync(fd); } catch {}
    }
  }
}

const run = (file: string, args: string[], timeoutMs = 4_000): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // lsof exits 1 when it finds nothing to list; its stdout is still the answer
      if (err && !(typeof stdout === "string" && (err as { code?: unknown }).code === 1)) resolve(null);
      else resolve(String(stdout));
    });
  });

/** `ps` TIME: [[dd-]hh:]mm:ss[.cc] */
function psTimeMs(raw: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60_000 + Number(s) * 1000;
}

/** The root and every descendant, from a `pid ppid ...` table. */
export function treePids(rows: Array<{ pid: number; ppid: number }>, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const r of rows) {
    const list = kids.get(r.ppid);
    if (list) list.push(r.pid);
    else kids.set(r.ppid, [r.pid]);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length && out.length < 512) {
    const pid = queue.shift()!;
    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  return out;
}

async function samplePosix(root: number): Promise<ProcessSample> {
  const table = await run("ps", ["-A", "-o", "pid=,ppid=,time="]);
  if (table === null) return { cpuMs: null, connections: null };
  const rows: Array<{ pid: number; ppid: number; cpuMs: number | null }> = [];
  for (const line of table.split("\n")) {
    const [pid, ppid, time] = line.trim().split(/\s+/);
    if (!pid || !ppid || !time) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpuMs: psTimeMs(time) });
  }
  const pids = treePids(rows, root);
  if (!rows.some((r) => r.pid === root)) return { cpuMs: null, connections: null };
  let cpuMs = 0;
  for (const r of rows) if (pids.includes(r.pid)) cpuMs += r.cpuMs ?? 0;
  const lsof = await run("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"]);
  // -Fn prints one `n<addr>` line per connection
  const connections = lsof === null ? null : lsof.split("\n").filter((l) => l.startsWith("n")).length;
  return { cpuMs, connections };
}

async function sampleWindows(root: number): Promise<ProcessSample> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$all=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime;" +
    `$ids=@(${root});$q=@(${root});` +
    "while($q.Count){$p=$q[0];$q=@($q|Select-Object -Skip 1);foreach($c in $all|Where-Object{$_.ParentProcessId -eq $p}){if($ids -notcontains $c.ProcessId){$ids+=$c.ProcessId;$q+=$c.ProcessId}}};" +
    "$cpu=($all|Where-Object{$ids -contains $_.ProcessId}|ForEach-Object{[double]$_.KernelModeTime+[double]$_.UserModeTime}|Measure-Object -Sum).Sum/10000;" +
    "$n=@(Get-NetTCPConnection -State Established|Where-Object{$ids -contains $_.OwningProcess}).Count;" +
    "Write-Output \"$cpu $n\"";
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8_000);
  const [cpu, n] = (out ?? "").trim().split(/\s+/);
  const cpuMs = Number(cpu);
  const connections = Number(n);
  return {
    cpuMs: cpu !== undefined && Number.isFinite(cpuMs) ? cpuMs : null,
    connections: n !== undefined && Number.isFinite(connections) ? connections : null,
  };
}

/** CPU time and open connections of a process and its children. Best
 *  effort: a missing tool or a refused query reads as null (unknown), never
 *  as "idle". */
export function sampleProcessTree(pid: number): Promise<ProcessSample> {
  return (process.platform === "win32" ? sampleWindows(pid) : samplePosix(pid))
    .catch(() => ({ cpuMs: null, connections: null }));
}

/** CPU a process tree can burn on bookkeeping while doing no real work. */
const BUSY_CPU_MS_PER_MIN = 3_000;

export function classifyQuiet(input: {
  /** the latest retry/compress fact logged since the agent went quiet */
  logged: LogSignal | null;
  /** the most recent history-size reading, at any time */
  context: { tokens: number; threshold: number } | null;
  sample: ProcessSample;
  /** the previous sample in this quiet spell, for the CPU delta */
  previous: ProcessSample | null;
  sinceMs: number;
}): QuietState {
  const { logged, sample, previous } = input;
  if (logged?.kind === "retry") return { kind: "retrying", status: logged.status, delayMs: logged.delayMs, attempt: logged.attempt };
  if (logged?.kind === "compressing") return { kind: "compressing" };
  const nearFullContext = input.context !== null && input.context.threshold > 0
    && input.context.tokens >= input.context.threshold * 0.9;
  if (sample.connections !== null && sample.connections > 0) return { kind: "waiting-model", nearFullContext };
  const cpuDelta = sample.cpuMs !== null && previous?.cpuMs != null ? sample.cpuMs - previous.cpuMs : null;
  if (cpuDelta !== null && input.sinceMs > 0 && cpuDelta > BUSY_CPU_MS_PER_MIN * (input.sinceMs / 60_000)) return { kind: "busy" };
  if (sample.connections === 0 && cpuDelta !== null) return { kind: "no-signs" };
  return { kind: "unknown" };
}

/** Two states read the same to a person when this matches; a notice is
 *  sent only when it changes. */
export function quietKey(state: QuietState): string {
  if (state.kind === "retrying") return `retrying:${state.attempt ?? "?"}:${state.status ?? "?"}`;
  if (state.kind === "waiting-model") return `waiting-model:${state.nearFullContext}`;
  return state.kind;
}

const minutes = (ms: number): string => {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
};

/** The chat notice for a quiet state. */
export function describeQuiet(name: string, state: QuietState, quietMs: number, stopAfterMs: number): string {
  const quiet = minutes(quietMs);
  switch (state.kind) {
    case "retrying": {
      const why = state.status === 429 ? "hit a rate limit (HTTP 429)"
        : state.status !== null && state.status >= 500 ? `got a server error from its model provider (HTTP ${state.status})`
        : state.status !== null ? `got an error from its model provider (HTTP ${state.status})`
        : "had a failed model request";
      const next = state.delayMs !== null ? ` Next try in ${Math.max(1, Math.round(state.delayMs / 1000))} s.` : "";
      const attempt = state.attempt !== null ? ` (attempt ${state.attempt + 1})` : "";
      return `${name} ${why} and is retrying${attempt}.${next} It is still working.`;
    }
    case "compressing":
      return `${name} is compressing its conversation history to make room. This can take a few minutes; it is still working.`;
    case "waiting-model":
      return state.nearFullContext
        ? `${name} is waiting on its model: no reply for ${quiet}, but its request is still open. Its history is nearly full, so it may be compressing it.`
        : `${name} is waiting on its model: no reply for ${quiet}, but its request is still open. Slow models and rate limits look like this.`;
    case "busy":
      return `${name} is busy on this computer but has sent nothing for ${quiet}.`;
    case "between-requests":
      return `${name} has sent nothing for ${quiet} and has no request open to its model right now. ` +
        "It may be waiting before a retry. Still waiting; press Stop to end the turn.";
    case "no-signs":
      return `${name} has sent nothing for ${quiet}, has no open request to its model, and is not using the CPU. It may be stuck. ` +
        `Press Stop to end the turn; otherwise it is stopped after ${minutes(stopAfterMs)} of silence.`;
    case "unknown":
      return `${name} has sent nothing for ${quiet}. Still waiting; press Stop to end the turn.`;
  }
}

/** A short phrase for the final stuck error: what the agent looked like last. */
export function lastSeenPhrase(state: QuietState): string {
  switch (state.kind) {
    case "retrying": return "retrying a failed model request";
    case "compressing": return "compressing its history";
    case "waiting-model": return "waiting on its model with a request open";
    case "busy": return "busy on this computer";
    case "between-requests": return "no request open to its model";
    case "no-signs": return "no open request and no CPU use";
    case "unknown": return "no readable process state";
  }
}
