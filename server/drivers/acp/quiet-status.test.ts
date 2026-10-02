import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import {
  classifyQuiet, describeQuiet, LogTail, parseQwenLogLine, quietKey, sampleProcessTree, treePids,
} from "./quiet-status.ts";
import { qwenDebugLogPath } from "./qwen.ts";

// Lines copied from a real Qwen Code 0.24.7 debug log, captured against a
// model endpoint that answered 429.
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

describe("describeQuiet", () => {
  it("says it in plain words", () => {
    expect(describeQuiet("Qwen", { kind: "retrying", status: 429, delayMs: 20_000, attempt: 1 }, 90_000, 900_000))
      .toBe("Qwen hit a rate limit (HTTP 429) and is retrying (attempt 2). Next try in 20 s. It is still working.");
    expect(describeQuiet("Qwen", { kind: "waiting-model", nearFullContext: false }, 125_000, 900_000)).toContain("no reply for 2 min");
    expect(describeQuiet("Qwen", { kind: "no-signs" }, 180_000, 900_000)).toContain("stopped after 15 min");
    expect(describeQuiet("Qwen", { kind: "between-requests" }, 25_000, 900_000))
      .toBe("Qwen has sent nothing for 25 s and has no request open to its model right now. It may be waiting before a retry. Still waiting; press Stop to end the turn.");
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

  it.skipIf(process.platform === "win32")("counts this process's open connections and CPU", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { connect } = await import("node:net");
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    try {
      const sample = await sampleProcessTree(process.pid);
      // Found, not "unknown". macOS `ps` prints TIME to the hundredth of a
      // second; Linux procps prints whole seconds, so a test worker that has
      // used under a second of CPU honestly reads 0 there.
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
