// What a quiet ACP agent is doing. ACP has no "still working" message, and agents go silent for minutes
// (Qwen Code 0.24 while it waits out a rate limit, retries, or runs a slow call), so a quiet turn is
// probed from the agent's debug log and its process tree's connections and CPU.

import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

import { redactSecretsInText } from "../../redact.ts";

// Prompt silence guard (0 disables). Healthy agents go quiet for minutes: Qwen Code 0.24 sends
// nothing while it compresses history, backs off a rate limit (60 s up to 5 min per wait) or runs
// one model request (its SDK waits up to 600 s); a wedged OpenCode turn goes silent forever.
export const DEFAULT_ACP_PROMPT_IDLE_MS = 15 * 60_000;
export const promptIdleTimeoutMs = (): number => {
  const raw = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_ACP_PROMPT_IDLE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
export const formatQuietLimit = (ms: number): string =>
  ms >= 120_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

/** Silence before the first "what is it doing" notice (OMB_ACP_QUIET_NOTICE_MS overrides). */
export const DEFAULT_QUIET_NOTICE_MS = 60_000;
/** How often a quiet turn or a long tool call is looked at again (OMB_ACP_QUIET_TICK_MS overrides). */
export const DEFAULT_QUIET_TICK_MS = 15_000;

const knob = (name: string, fallback: number): number => {
  const ms = Number(process.env[name]);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
};
export const quietNoticeMs = (): number => knob("OMB_ACP_QUIET_NOTICE_MS", DEFAULT_QUIET_NOTICE_MS);
export const quietTickMs = (): number => knob("OMB_ACP_QUIET_TICK_MS", DEFAULT_QUIET_TICK_MS);

export type LogSignal =
  | { kind: "retry"; status: number | null; delayMs: number | null; attempt: number | null }
  | { kind: "compressing" }
  | { kind: "context"; tokens: number; threshold: number }
  | { kind: "provider-error"; message: string };

export type QuietState =
  | { kind: "retrying"; status: number | null; delayMs: number | null; attempt: number | null }
  | { kind: "compressing" }
  | { kind: "provider-error"; message: string }
  | { kind: "waiting-model"; nearFullContext: boolean }
  | { kind: "busy" }
  /** no connection, no CPU, briefly: an SDK sleeping between retries looks like this */
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
 *  `2026-10-02T02:50:41.757Z [WARN] [RETRY] Attempt 1 failed with status 429. Retrying after explicit delay of 20000ms...`. */
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

/** OpenCode 1.18's shared log, one logfmt row per failed model call of any session or process, like
 *  `level=ERROR … message="stream error" … session.id=ses_… small=false … error.error="AI_APICallError: Rate limit exceeded."`.
 *  `small=true` is the session's title request, not the turn. */
export function parseOpenCodeLogLine(line: string, sessionId: string): LogSignal | null {
  const fields = line.split(" ");
  if (!fields.includes("level=ERROR") || !fields.includes(`session.id=${sessionId}`) || fields.includes("small=true")) return null;
  const error = /\berror\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  return error ? { kind: "provider-error", message: redactSecretsInText(error.replace(/^AI_APICallError:\s*/, "")).slice(0, 200) } : null;
}

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
      if (size < this.offset) { this.offset = 0; this.partial = ""; }
      if (size === this.offset) return [];
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

// A server can run with a narrowed PATH (a sealed test fixture runs with node's folder alone); ps and lsof are still
// found where the system keeps them.
const SYSTEM_DIRS = ["/bin", "/usr/bin", "/usr/sbin", "/sbin"];
const systemTools = new Map<string, string>();
const systemTool = (name: string): string => {
  let path = systemTools.get(name);
  if (path === undefined) {
    path = SYSTEM_DIRS.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate)) ?? name;
    systemTools.set(name, path);
  }
  return path;
};

/** `ps` TIME: [[dd-]hh:]mm:ss[.cc] */
function psTimeMs(raw: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60_000 + Number(s) * 1000;
}

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

/** A process start is read to the second (`ps` etime), so a call's own processes may look this much older than it. */
const START_SLACK_MS = 2_000;

/** What one tool call is running: the root's descendants that started since the call did, not the root itself. */
export function startedSince(rows: Array<{ pid: number; ppid: number; startedAt: number | null }>, root: number, since: number): number[] {
  const startOf = new Map(rows.map((r) => [r.pid, r.startedAt]));
  return treePids(rows, root).filter((pid) => pid !== root && (startOf.get(pid) ?? -Infinity) >= since - START_SLACK_MS);
}

async function samplePosix(root: number, since?: number): Promise<ProcessSample> {
  const table = await run(systemTool("ps"), ["-A", "-o", "pid=,ppid=,time=,etime="]);
  if (table === null) return { cpuMs: null, connections: null };
  const now = Date.now();
  const rows: Array<{ pid: number; ppid: number; cpuMs: number | null; startedAt: number | null }> = [];
  for (const line of table.split("\n")) {
    const [pid, ppid, time, elapsed] = line.trim().split(/\s+/);
    if (!pid || !ppid || !time) continue;
    const age = elapsed ? psTimeMs(elapsed) : null;
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpuMs: psTimeMs(time), startedAt: age === null ? null : now - age });
  }
  if (!rows.some((r) => r.pid === root)) return { cpuMs: null, connections: null };
  const pids = since === undefined ? treePids(rows, root) : startedSince(rows, root, since);
  if (!pids.length) return { cpuMs: null, connections: null };
  let cpuMs = 0;
  for (const r of rows) if (pids.includes(r.pid)) cpuMs += r.cpuMs ?? 0;
  const lsof = await run(systemTool("lsof"), ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"]);
  // -Fn prints one `n<addr>` line per connection
  const connections = lsof === null ? null : lsof.split("\n").filter((l) => l.startsWith("n")).length;
  return { cpuMs, connections };
}

async function sampleWindows(root: number, since?: number): Promise<ProcessSample> {
  const own = since === undefined ? ""
    : `$from=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(since - START_SLACK_MS)}).LocalDateTime;` +
      `$ids=@($all|Where-Object{($ids -contains $_.ProcessId) -and $_.ProcessId -ne ${root} -and $_.CreationDate -ge $from}|ForEach-Object{$_.ProcessId});` +
      "if(-not $ids.Count){Write-Output 'none';exit};";
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$all=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CreationDate;" +
    `$ids=@(${root});$q=@(${root});` +
    "while($q.Count){$p=$q[0];$q=@($q|Select-Object -Skip 1);foreach($c in $all|Where-Object{$_.ParentProcessId -eq $p}){if($ids -notcontains $c.ProcessId){$ids+=$c.ProcessId;$q+=$c.ProcessId}}};" +
    own +
    "$cpu=($all|Where-Object{$ids -contains $_.ProcessId}|ForEach-Object{[double]$_.KernelModeTime+[double]$_.UserModeTime}|Measure-Object -Sum).Sum/10000;" +
    "$n=@(Get-NetTCPConnection -State Established|Where-Object{$ids -contains $_.OwningProcess}).Count;" +
    "Write-Output \"$cpu $n\"";
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8_000);
  if (out?.trim() === "none") return { cpuMs: null, connections: null };
  const [cpu, n] = (out ?? "").trim().split(/\s+/);
  const cpuMs = Number(cpu);
  const connections = Number(n);
  return {
    cpuMs: cpu !== undefined && Number.isFinite(cpuMs) ? cpuMs : null,
    connections: n !== undefined && Number.isFinite(connections) ? connections : null,
  };
}

/** What Linux's /proc says, read through these (a test passes a fake tree). */
export interface ProcReader {
  read(path: string): string;
  list(path: string): string[];
  link(path: string): string;
}

const realProc: ProcReader = { read: (path) => readFileSync(path, "utf8"), list: (path) => readdirSync(path), link: (path) => readlinkSync(path) };

/** Clock ticks per second in /proc/<pid>/stat: USER_HZ, 100 on every Linux this runs on. */
const PROC_TICKS = 100;

/** Linux from /proc alone, so an image without procps or lsof (a Cloud home's) still says what a quiet engine does, as
 * ps and lsof do elsewhere: CPU is the tree's utime and stime; connections are its established TCP sockets, read in each
 * network namespace the tree lives in (a boxed engine has its own). */
export function sampleLinuxProc(root: number, since?: number, proc: ProcReader = realProc): ProcessSample {
  const unknown = { cpuMs: null, connections: null };
  let names: string[];
  try { names = proc.list("/proc"); } catch { return unknown; }
  let bootMs = 0;
  try { bootMs = Number(/^btime (\d+)$/m.exec(proc.read("/proc/stat"))?.[1] ?? 0) * 1000; } catch {}
  const rows: Array<{ pid: number; ppid: number; cpuMs: number; startedAt: number | null }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = proc.read(`/proc/${name}/stat`); } catch { continue; }
    // pid (comm) state ppid …: comm may hold spaces and parentheses; utime, stime and starttime are fields 14, 15 and 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0), started = Number(fields[19]);
    rows.push({ pid: Number(name), ppid: Number(fields[1]), cpuMs: ticks * (1000 / PROC_TICKS), startedAt: bootMs && Number.isFinite(started) ? bootMs + started * (1000 / PROC_TICKS) : null });
  }
  if (!rows.some((row) => row.pid === root)) return unknown;
  const pids = since === undefined ? treePids(rows, root) : startedSince(rows, root, since);
  if (!pids.length) return unknown;
  const cpuMs = rows.filter((row) => pids.includes(row.pid)).reduce((sum, row) => sum + row.cpuMs, 0);
  const sockets = new Set<string>();
  const namespaces = new Map<string, number>();
  for (const pid of pids) {
    try { const ns = proc.link(`/proc/${pid}/ns/net`); if (!namespaces.has(ns)) namespaces.set(ns, pid); } catch {}
    let fds: string[];
    try { fds = proc.list(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { const inode = /^socket:\[(\d+)\]$/.exec(proc.link(`/proc/${pid}/fd/${fd}`))?.[1]; if (inode) sockets.add(inode); } catch {}
    }
  }
  let connections = 0, readable = false;
  for (const pid of namespaces.size ? namespaces.values() : [root]) {
    for (const table of ["tcp", "tcp6"]) {
      let text: string;
      try { text = proc.read(`/proc/${pid}/net/${table}`); readable = true; } catch { continue; }
      for (const line of text.split("\n").slice(1)) {
        // sl local_address rem_address st … inode: st 01 is ESTABLISHED; addresses are hex, the port after the colon.
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 10 && cols[3] === "01" && sockets.has(cols[9]!)) connections += 1;
      }
    }
  }
  return { cpuMs, connections: readable ? connections : null };
}

/** A missing tool or a refused query reads as null (unknown), never as idle. With `since`, only the processes the tree
 * started from then on count, without the root: what one tool call is running, not the engine or its tool servers. */
export function sampleProcessTree(pid: number, since?: number): Promise<ProcessSample> {
  if (process.platform === "linux") {
    try { return Promise.resolve(sampleLinuxProc(pid, since)); } catch { return Promise.resolve({ cpuMs: null, connections: null }); }
  }
  return (process.platform === "win32" ? sampleWindows(pid, since) : samplePosix(pid, since))
    .catch(() => ({ cpuMs: null, connections: null }));
}

/** A model request that failed on a usage or rate limit: an engine that then goes quiet is waiting that limit out
 * (OpenCode 1.18 sleeps for the provider's whole retry-after, uncapped, five times over). */
export const LIMIT_WORDS = /\b429\b|rate.?limit|too many requests|usage limit|quota|GoUsageLimitError|FreeUsageLimitError|insufficient_quota|credits? (?:exhausted|used up)|out of credits/i;

/** How long an engine may stay quiet after a model request failed on a limit before the turn is ended as a usage limit,
 * so the bot carries on with another AI: longer than any retry an engine makes without a provider's retry-after
 * (OMB_ACP_LIMIT_QUIET_MS overrides). */
export const DEFAULT_LIMIT_QUIET_MS = 2 * 60_000;
export const limitQuietMs = (): number => knob("OMB_ACP_LIMIT_QUIET_MS", DEFAULT_LIMIT_QUIET_MS);

/** No open request, no CPU and nothing logged, this long: the engine is stuck, and the turn is stopped
 * (OMB_ACP_NO_SIGNS_STOP_MS overrides). */
export const DEFAULT_NO_SIGNS_STOP_MS = 5 * 60_000;
export const noSignsStopMs = (): number => knob("OMB_ACP_NO_SIGNS_STOP_MS", DEFAULT_NO_SIGNS_STOP_MS);

/** Whether this quiet state is an engine waiting out a usage or rate limit. */
export function waitingOutLimit(signal: LogSignal | null): boolean {
  if (!signal) return false;
  if (signal.kind === "provider-error") return LIMIT_WORDS.test(signal.message);
  return signal.kind === "retry" && signal.status === 429 && (signal.delayMs ?? 0) > limitQuietMs();
}

/** A quiet turn after it is classified: no sign of life reads as "between requests" until `stuckAfterMs`, and the turn
 * ends, with the error its prompt fails with, when the engine is waiting out a usage limit `limitQuietMs()` after the
 * request that failed on it, or has shown no sign of life for `noSignsStopMs()`. */
export function quietVerdict(input: {
  next: QuietState; logged: { signal: LogSignal; at: number } | null; noSignsSince: number | null; now: number; quietMs: number; name: string; stuckAfterMs: number;
}): { next: QuietState; noSignsSince: number | null; stop: Error | null } {
  let next = input.next, noSignsSince = input.noSignsSince;
  if (next.kind === "no-signs") {
    noSignsSince ??= input.now;
    if (input.now - noSignsSince < input.stuckAfterMs) next = { kind: "between-requests" };
  } else {
    noSignsSince = null;
  }
  const limited = input.logged && waitingOutLimit(input.logged.signal) && input.now - input.logged.at >= limitQuietMs() ? input.logged.signal : null;
  if (limited) {
    const said = limited.kind === "provider-error" ? ` (“${limited.message}”)` : "";
    return { next, noSignsSince, stop: Object.assign(new Error(`${input.name} reached a usage limit${said} and is waiting it out without replying, so this turn was stopped.`), { acpUsageLimit: true }) };
  }
  if (noSignsSince !== null && input.now - noSignsSince >= noSignsStopMs()) {
    return { next, noSignsSince, stop: Object.assign(new Error(`${input.name} sent nothing for ${formatQuietLimit(input.quietMs)} with no tool running, no open request to its model and no CPU use, so the turn was stopped as stuck. Send the message again to retry.`), { acpPromptStall: true }) };
  }
  return { next, noSignsSince, stop: null };
}

const BUSY_CPU_MS_PER_MIN = 3_000;

export function classifyQuiet(input: {
  logged: LogSignal | null;
  context: { tokens: number; threshold: number } | null;
  sample: ProcessSample;
  previous: ProcessSample | null;
  sinceMs: number;
}): QuietState {
  const { logged, sample, previous } = input;
  if (logged?.kind === "retry") return { kind: "retrying", status: logged.status, delayMs: logged.delayMs, attempt: logged.attempt };
  if (logged?.kind === "compressing") return { kind: "compressing" };
  if (logged?.kind === "provider-error") return { kind: "provider-error", message: logged.message };
  const nearFullContext = input.context !== null && input.context.threshold > 0
    && input.context.tokens >= input.context.threshold * 0.9;
  if (sample.connections !== null && sample.connections > 0) return { kind: "waiting-model", nearFullContext };
  const cpuDelta = sample.cpuMs !== null && previous?.cpuMs != null ? sample.cpuMs - previous.cpuMs : null;
  if (cpuDelta !== null && input.sinceMs > 0 && cpuDelta > BUSY_CPU_MS_PER_MIN * (input.sinceMs / 60_000)) return { kind: "busy" };
  if (sample.connections === 0 && cpuDelta !== null) return { kind: "no-signs" };
  return { kind: "unknown" };
}

export function quietKey(state: QuietState): string {
  if (state.kind === "retrying") return `retrying:${state.attempt ?? "?"}:${state.status ?? "?"}`;
  if (state.kind === "waiting-model") return `waiting-model:${state.nearFullContext}`;
  return state.kind;
}

const minutes = (ms: number): string => {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
};

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
    case "provider-error":
      return `${name}'s model request failed: "${state.message}" ${name} may retry or stop; no reply for ${quiet} so far.`;
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

export function lastSeenPhrase(state: QuietState): string {
  switch (state.kind) {
    case "retrying": return "retrying a failed model request";
    case "compressing": return "compressing its history";
    case "provider-error": return "a failed model request";
    case "waiting-model": return "waiting on its model with a request open";
    case "busy": return "busy on this computer";
    case "between-requests": return "no request open to its model";
    case "no-signs": return "no open request and no CPU use";
    case "unknown": return "no readable process state";
  }
}
