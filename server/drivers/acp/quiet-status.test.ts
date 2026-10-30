import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import {
  classifyQuiet, describeQuiet, LogTail, parseOpenCodeLogLine, parseQwenLogLine, quietKey, sampleLinuxProc, sampleProcessTree, startedSince, treePids,
  quietVerdict, waitingOutLimit, type ProcReader,
} from "./quiet-status.ts";
import { qwenDebugLogPath } from "./qwen.ts";

// Lines from a real Qwen Code 0.24.7 debug log against an endpoint that answered 429.
const RETRY_EXPLICIT = "2026-10-02T02:50:41.757Z [WARN] [RETRY] Attempt 1 failed with status 429. Retrying after explicit delay of 20000ms... {";
const RETRY_BACKOFF = "2026-10-02T02:51:41.757Z [ERROR] [RETRY] Attempt 3 failed with status 503. Retrying in 12s...";
const GATE = "2026-10-02T02:49:41.570Z [DEBUG] [COMPRESSION] [compaction] cheap-gate NOOP: effectiveTokens=2587, auto=167000, contextLimit=200000";

describe("parseQwenLogLine", () => {
  it("reads a retry's attempt, status and delay", () => {
    expect(parseQwenLogLine(RETRY_EXPLICIT)).toEqual({ kind: "retry", attempt: 1, status: 429, delayMs: 20_000 });
    expect(parseQwenLogLine(RETRY_BACKOFF)).toEqual({ kind: "retry", attempt: 3, status: 503, delayMs: 12_000 });
  });

  it("reads the history size from the compression gate, which is not itself a compression", () => {
    expect(parseQwenLogLine(GATE)).toEqual({ kind: "context", tokens: 2587, threshold: 167000 });
  });

  it("reports an explicit compression, but not its outcome", () => {
    expect(parseQwenLogLine("x [WARN] [compaction] hard-tier rescue triggered: prompt_id=p, effectiveTokens=9")).toEqual({ kind: "compressing" });
    expect(parseQwenLogLine("x [INFO] Reactive compression succeeded: 10 -> 5 tokens.")).toBeNull();
  });

  it("ignores everything else", () => {
    expect(parseQwenLogLine("2026-10-02T02:49:41.426Z [DEBUG] Extension manager initialized")).toBeNull();
  });
});

describe("classifyQuiet", () => {
  const sample = (cpuMs: number | null, connections: number | null) => ({ cpuMs, connections });

  it("prefers what the agent's log says over the probe", () => {
    const logged = parseQwenLogLine(RETRY_EXPLICIT);
    expect(classifyQuiet({ logged, context: null, sample: sample(0, 0), previous: sample(0, 0), sinceMs: 15_000 }).kind).toBe("retrying");
  });

  it("an open connection means it is waiting on its model", () => {
    expect(classifyQuiet({ logged: null, context: null, sample: sample(100, 1), previous: null, sinceMs: 0 }))
      .toEqual({ kind: "waiting-model", nearFullContext: false });
    expect(classifyQuiet({ logged: null, context: { tokens: 160_000, threshold: 167_000 }, sample: sample(100, 2), previous: null, sinceMs: 0 }))
      .toEqual({ kind: "waiting-model", nearFullContext: true });
  });

  it("CPU without a connection is busy; neither is no sign of life", () => {
    expect(classifyQuiet({ logged: null, context: null, sample: sample(20_000, 0), previous: sample(1_000, 0), sinceMs: 15_000 }).kind).toBe("busy");
    expect(classifyQuiet({ logged: null, context: null, sample: sample(1_050, 0), previous: sample(1_000, 0), sinceMs: 15_000 }).kind).toBe("no-signs");
  });

  it("never calls an unreadable process idle", () => {
    expect(classifyQuiet({ logged: null, context: null, sample: sample(null, null), previous: null, sinceMs: 0 }).kind).toBe("unknown");
    expect(classifyQuiet({ logged: null, context: null, sample: sample(1_000, 0), previous: null, sinceMs: 0 }).kind).toBe("unknown");
  });
});

// The row format of a real opencode log, with synthetic identifiers.
const openCodeRow = (fields: string) =>
  `timestamp=2026-10-01T00:00:03.000Z level=ERROR run=fixture_run message="stream error" providerID=opencode modelID=mimo-v2.6-flash-free ${fields}`;

describe("parseOpenCodeLogLine", () => {
  it("reads only this session's main-request errors", () => {
    const limit = 'error.error="AI_APICallError: Rate limit exceeded. Please try again later."';
    expect(parseOpenCodeLogLine(openCodeRow(`session.id=ses_a small=false agent=build mode=primary ${limit}`), "ses_a"))
      .toEqual({ kind: "provider-error", message: "Rate limit exceeded. Please try again later." });
    expect(parseOpenCodeLogLine(openCodeRow(`session.id=ses_b small=false ${limit}`), "ses_a")).toBeNull();
    expect(parseOpenCodeLogLine(openCodeRow(`session.id=ses_ab small=false ${limit}`), "ses_a")).toBeNull();
    expect(parseOpenCodeLogLine(openCodeRow(`session.id=ses_a small=true agent=title ${limit}`), "ses_a")).toBeNull();
    expect(parseOpenCodeLogLine(openCodeRow(`session.id=ses_a small=false ${limit}`).replace("level=ERROR", "level=WARN"), "ses_a")).toBeNull();
    expect(parseOpenCodeLogLine(openCodeRow("session.id=ses_a small=false"), "ses_a")).toBeNull();
  });

  it("never repeats a key the provider echoed", () => {
    const signal = parseOpenCodeLogLine(openCodeRow('session.id=ses_a error.error="AI_APICallError: Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz123456"'), "ses_a");
    expect(signal).toMatchObject({ kind: "provider-error", message: expect.stringContaining("Incorrect API key provided") });
    expect(JSON.stringify(signal)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("keeps an escaped quote inside the error", () => {
    expect(parseOpenCodeLogLine(openCodeRow('session.id=ses_a error.error="Model \\"x\\" is overloaded" next=1'), "ses_a"))
      .toEqual({ kind: "provider-error", message: 'Model \\"x\\" is overloaded' });
  });
});

describe("describeQuiet", () => {
  it("says it in plain words", () => {
    expect(describeQuiet("Qwen", { kind: "retrying", status: 429, delayMs: 20_000, attempt: 1 }, 90_000, 900_000))
      .toBe("Qwen hit a rate limit (HTTP 429) and is retrying (attempt 2). Next try in 20 s. It is still working.");
    expect(describeQuiet("Qwen", { kind: "waiting-model", nearFullContext: false }, 125_000, 900_000)).toContain("no reply for 2 min");
    expect(describeQuiet("Qwen", { kind: "no-signs" }, 180_000, 900_000)).toContain("stopped after 15 min");
    expect(describeQuiet("Qwen", { kind: "between-requests" }, 25_000, 900_000))
      .toBe("Qwen has sent nothing for 25 s and has no request open to its model right now. It may be waiting before a retry. Still waiting; press Stop to end the turn.");
    expect(describeQuiet("OpenCode", { kind: "provider-error", message: "Rate limit exceeded. Please try again later." }, 75_000, 900_000))
      .toBe('OpenCode\'s model request failed: "Rate limit exceeded. Please try again later." OpenCode may retry or stop; no reply for 75 s so far.');
  });

  it("a new retry attempt is news; the same state is not", () => {
    expect(quietKey({ kind: "retrying", status: 429, delayMs: 1, attempt: 1 }))
      .not.toBe(quietKey({ kind: "retrying", status: 429, delayMs: 1, attempt: 2 }));
    expect(quietKey({ kind: "busy" })).toBe(quietKey({ kind: "busy" }));
  });
});

describe("LogTail", () => {
  it("skips what was there, then returns only new complete lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-logtail-"));
    try {
      const file = join(dir, "s.txt");
      writeFileSync(file, "old line\n");
      const tail = new LogTail(file);
      expect(tail.read()).toEqual([]);
      appendFileSync(file, "one\ntw");
      expect(tail.read()).toEqual(["one"]);
      appendFileSync(file, "o\n");
      expect(tail.read()).toEqual(["two"]);
      writeFileSync(file, "fresh\n");
      expect(tail.read()).toEqual(["fresh"]);
    } finally {
      removeTempDir(dir);
    }
  });

  it("reads a log that appears after the watch began from its start", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-logtail-"));
    try {
      const file = join(dir, "later.txt");
      const tail = new LogTail(file);
      expect(tail.read()).toEqual([]);
      writeFileSync(file, "first\n");
      expect(tail.read()).toEqual(["first"]);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("process probe", () => {
  it("walks a process tree", () => {
    expect(treePids([{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 9 }], 1)).toEqual([1, 2, 3]);
  });

  it("counts only what a tool call started: never the engine itself, nor the tool servers it started before", () => {
    const rows = [
      { pid: 10, ppid: 1, startedAt: 60_200 },
      { pid: 11, ppid: 10, startedAt: 1_000 },
      { pid: 12, ppid: 10, startedAt: 60_000 },
      { pid: 13, ppid: 12, startedAt: 60_500 },
      { pid: 14, ppid: 10, startedAt: null },
      { pid: 20, ppid: 1, startedAt: 61_000 },
    ];
    expect(startedSince(rows, 10, 61_000), "an engine started for this very turn, as Codex's app-server is, is still not the call").toEqual([12, 13]);
    expect(startedSince(rows, 10, 90_000)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("samples a tool call's own processes, and reads nothing it did not start as unknown", async () => {
    const since = Date.now();
    const child = spawn(process.execPath, ["-e", "const t = Date.now(); while (Date.now() - t < 2500) {} setInterval(() => {}, 1000);"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_700));
      const own = await sampleProcessTree(process.pid, since);
      // Linux procps prints TIME in whole seconds: 2.5 s of spinning reads at least one even on a busy runner.
      expect(own.cpuMs).not.toBeNull();
      expect(own.cpuMs!).toBeGreaterThanOrEqual(1_000);
      expect(await sampleProcessTree(process.pid, Date.now() + 60_000)).toEqual({ cpuMs: null, connections: null });
    } finally {
      child.kill();
    }
  });

  it.skipIf(process.platform === "win32")("counts this process's open connections and CPU", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { connect } = await import("node:net");
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    try {
      const sample = await sampleProcessTree(process.pid);
      // macOS `ps` prints TIME to the hundredth; Linux procps prints whole seconds, so under a second reads 0.
      expect(sample.cpuMs).not.toBeNull();
      expect(sample.cpuMs!).toBeGreaterThanOrEqual(0);
      if (process.platform === "darwin") expect(sample.cpuMs!).toBeGreaterThan(0);
      // lsof may be missing on a minimal Linux box: unknown, never zero
      if (sample.connections !== null) expect(sample.connections).toBeGreaterThanOrEqual(1);
    } finally {
      socket.destroy();
      server.close();
    }
  });
});

describe("qwenDebugLogPath", () => {
  it("follows Qwen's runtime-dir rules and respects the log being turned off", () => {
    expect(qwenDebugLogPath({ QWEN_DEBUG_LOG_FILE: "1", HOME: "/h" }, "abc-1")).toBe(join("/h", ".qwen", "debug", "abc-1.txt"));
    expect(qwenDebugLogPath({ QWEN_DEBUG_LOG_FILE: "1", QWEN_HOME: "/q" }, "abc")).toBe(join("/q", "debug", "abc.txt"));
    expect(qwenDebugLogPath({ QWEN_DEBUG_LOG_FILE: "1", QWEN_HOME: "/q", QWEN_RUNTIME_DIR: "/r" }, "abc")).toBe(join("/r", "debug", "abc.txt"));
    expect(qwenDebugLogPath({ QWEN_DEBUG_LOG_FILE: "0" }, "abc")).toBeNull();
    expect(qwenDebugLogPath({ QWEN_DEBUG_LOG_FILE: "1" }, "../escape")).toBeNull();
  });
});

describe("a Linux process tree from /proc alone", () => {
  // stat as /proc/<pid>/stat writes it: utime, stime and starttime are fields 14, 15 and 22, after a comm with spaces.
  const stat = (pid: number, ppid: number, utime: number, stime: number, start: number) =>
    `${pid} (node (mcp) x) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 1000 100`;
  const row = (inode: number, remote: string, state = "01") => `   0: 0100007F:9C40 ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  // An engine (100) and its MCP server (101) in one network namespace, the engine's boxed child (102) in its own, and a
  // process of something else (200).
  const files: Record<string, string> = {
    "/proc/stat": "cpu  1 2 3 4\nbtime 1700000000\n",
    "/proc/100/stat": stat(100, 1, 300, 200, 1000),
    "/proc/101/stat": stat(101, 100, 50, 50, 1200),
    "/proc/102/stat": stat(102, 101, 100, 0, 5000),
    "/proc/200/stat": stat(200, 1, 9999, 0, 10),
    "/proc/100/net/tcp": [header, row(11, "0100007F:225F"), row(12, "5DB8D822:01BB"), row(13, "00000000:0000", "0A"), row(15, "5DB8D822:01BB")].join("\n"),
    "/proc/100/net/tcp6": header,
    "/proc/102/net/tcp": [header, row(14, "0100007F:0C38")].join("\n"),
    "/proc/102/net/tcp6": header,
  };
  const links: Record<string, string> = {
    "/proc/100/ns/net": "net:[1]", "/proc/101/ns/net": "net:[1]", "/proc/102/ns/net": "net:[2]",
    "/proc/100/fd/0": "/dev/null", "/proc/100/fd/3": "socket:[11]", "/proc/100/fd/4": "socket:[12]", "/proc/101/fd/5": "socket:[13]",
    "/proc/102/fd/6": "socket:[14]", "/proc/200/fd/7": "socket:[15]",
  };
  const lists: Record<string, string[]> = {
    "/proc": ["100", "101", "102", "200", "self", "stat"], "/proc/100/fd": ["0", "3", "4"], "/proc/101/fd": ["5"], "/proc/102/fd": ["6"], "/proc/200/fd": ["7"],
  };
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const proc = (overrides: Partial<Record<keyof ProcReader, (path: string) => never>> = {}): ProcReader => ({
    read: (path) => { if (path in files) return files[path]!; throw missing(path); },
    list: (path) => { if (path in lists) return lists[path]!; throw missing(path); },
    link: (path) => { if (path in links) return links[path]!; throw missing(path); },
    ...overrides,
  });

  it("adds the tree's CPU, and counts its open connections in each of its network namespaces", () => {
    // 11 is the harness on loopback; 12 a model request; 13 listens; 14 is the box's egress gate on loopback 3128;
    // 15 belongs to another process.
    expect(sampleLinuxProc(100, undefined, proc())).toEqual({ cpuMs: 7_000, connections: 3 });
  });

  it("counts only what started since a time, without the root, as a tool call's own processes", () => {
    const boot = 1_700_000_000_000;
    expect(sampleLinuxProc(100, boot + 40_000, proc())).toEqual({ cpuMs: 1_000, connections: 1 });
    expect(sampleLinuxProc(100, boot + 90_000, proc())).toEqual({ cpuMs: null, connections: null });
  });

  it("reads nothing it cannot see as unknown, never as idle", () => {
    expect(sampleLinuxProc(999, undefined, proc()), "no such process").toEqual({ cpuMs: null, connections: null });
    expect(sampleLinuxProc(100, undefined, proc({ list: (path) => { throw missing(path); } }))).toEqual({ cpuMs: null, connections: null });
    const noTables = proc({ read: (path) => { if (path.includes("/net/")) throw missing(path); if (path in files) return files[path] as never; throw missing(path); } });
    expect(sampleLinuxProc(100, undefined, noTables)).toEqual({ cpuMs: 7_000, connections: null });
  });
});

describe("an engine waiting out a limit", () => {
  it("is a model request that failed on a usage or rate limit, or a long wait after a 429", () => {
    expect(waitingOutLimit({ kind: "provider-error", message: "Usage limit reached" })).toBe(true);
    expect(waitingOutLimit({ kind: "provider-error", message: "Rate limit exceeded. Please try again later." })).toBe(true);
    expect(waitingOutLimit({ kind: "provider-error", message: "Incorrect API key provided" })).toBe(false);
    expect(waitingOutLimit({ kind: "provider-error", message: 'Model \\"x\\" is overloaded' })).toBe(false);
    expect(waitingOutLimit({ kind: "retry", status: 429, delayMs: 20_000, attempt: 1 })).toBe(false);
    expect(waitingOutLimit({ kind: "retry", status: 429, delayMs: 600_000, attempt: 1 })).toBe(true);
    expect(waitingOutLimit({ kind: "retry", status: 503, delayMs: 600_000, attempt: 1 })).toBe(false);
    expect(waitingOutLimit(null)).toBe(false);
  });
});

describe("ending a quiet turn early", () => {
  const base = { logged: null, noSignsSince: null, now: 1_000_000, quietMs: 420_000, name: "OpenCode Go", stuckAfterMs: 180_000 };
  it("reads no sign of life as between requests at first, and stops the turn as stuck once it lasts five minutes", () => {
    expect(quietVerdict({ ...base, next: { kind: "no-signs" } })).toEqual({ next: { kind: "between-requests" }, noSignsSince: 1_000_000, stop: null });
    expect(quietVerdict({ ...base, next: { kind: "no-signs" }, noSignsSince: 1_000_000 - 200_000 })).toMatchObject({ next: { kind: "no-signs" }, stop: null });
    const stuck = quietVerdict({ ...base, next: { kind: "no-signs" }, noSignsSince: 1_000_000 - 300_000 }).stop;
    expect(stuck?.message).toBe("OpenCode Go sent nothing for 7 min with no tool running, no open request to its model and no CPU use, so the turn was stopped as stuck. Send the message again to retry.");
    expect(stuck).toMatchObject({ acpPromptStall: true });
    expect(quietVerdict({ ...base, next: { kind: "waiting-model", nearFullContext: false }, noSignsSince: 1 }), "a sign of life starts it over").toEqual({ next: { kind: "waiting-model", nearFullContext: false }, noSignsSince: null, stop: null });
  });

  it("ends the turn as a usage limit two minutes after the request that failed on one, and never for another error", () => {
    const limit = { kind: "provider-error" as const, message: "Usage limit reached" };
    expect(quietVerdict({ ...base, next: { kind: "provider-error", message: limit.message }, logged: { signal: limit, at: 1_000_000 - 60_000 } }).stop).toBeNull();
    const ended = quietVerdict({ ...base, next: { kind: "provider-error", message: limit.message }, logged: { signal: limit, at: 1_000_000 - 120_000 } }).stop;
    expect(ended?.message).toBe("OpenCode Go reached a usage limit (“Usage limit reached”) and is waiting it out without replying, so this turn was stopped.");
    expect(ended).toMatchObject({ acpUsageLimit: true });
    const other = { kind: "provider-error" as const, message: "Incorrect API key provided" };
    expect(quietVerdict({ ...base, next: { kind: "provider-error", message: other.message }, logged: { signal: other, at: 0 } }).stop).toBeNull();
  });
});
