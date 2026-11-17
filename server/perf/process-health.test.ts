import { describe, expect, it } from "vitest";
import type { ProcessLimits } from "../process-limits.ts";
import { classifyProcesses, type ProcessRow } from "./process-buckets.ts";
import { perfHealth, perfLines, PERF_HEALTH_MAX_BYTES, type PerfSources } from "./perf-report.ts";
import { createProcessHealth, processHealthLines, tally, trimmedProcessHealth, type ProcessHealth } from "./process-health.ts";
import { linuxProcessList, MAX_SAMPLED_PROCESSES } from "./process-sampler.ts";
import { createTurnTimings } from "./turn-timings.ts";

const MB = 1024 * 1024;
const SECRETS = [
  "sk-ant-api03-PRIVATEPRIVATEPRIVATE1234567890", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "hunter2-password", "ada@example.test",
  "/Users/ada/Projects/acme-merger/plan.md", "acme-merger", "https://intranet.acme.test/q?token=abc", "intranet.acme.test",
  "Summarize the merger plan", "acme-internal", "Tallyspoon", "OMB_SECRET_VALUE_42", "lookup_customer", "Ada's Claude",
];
const leaks = (text: string) => SECRETS.filter((secret) => text.toLowerCase().includes(secret.toLowerCase()));

const SERVER = 14;
const row = (pid: number, ppid: number, name: string, threads = 7, state = "S"): ProcessRow => ({ pid, ppid, name, cpuMs: 1, rssBytes: MB, start: `s${pid}`, threads, state });
/** A container: tini, the launcher, the server; two engines with their tool servers and a command; a browser; orphans. */
const rows = (): ProcessRow[] => [
  row(1, 0, "tini", 1), row(7, 1, "node"), row(SERVER, 7, "node", 11),
  row(100, SERVER, "claude", 12), row(101, 100, "node"), row(102, 100, "node"), row(103, 100, "sh", 1), row(104, 103, "git", 1),
  row(200, SERVER, "node", 9), row(201, 200, "uvx", 3),
  row(300, SERVER, "agent-browser", 12), row(301, 300, "chromium", 35), row(302, 301, "chromium", 18),
  row(400, 1, "sleep", 1, "Z"), row(401, 1, "chromium", 1, "Z"),
];
const limits = (over: Partial<ProcessLimits> = {}): ProcessLimits => ({ pidsMax: 512, pidsCurrent: 126, nproc: "unlimited", shmBytes: 64 * MB, pid1: "init", reaper: "yes", ...over });
const quiet = { running: 0, queued: 0, longestWaitMs: 0, most: null, queuedEver: 0, starvedEver: 0 };
const none = { limit: null, spawnFailed: { EAGAIN: 0, EMFILE: 0, ENFILE: 0, ENOMEM: 0, ENOENT: 0, other: 0 }, forceKilled: 0, lateReaped: 0 };

describe("the process-room record", () => {
  it("counts processes by kind, threads, zombies and open files, and keeps the most of each since start", () => {
    const list = rows(), buckets = classifyProcesses(list, SERVER, true, new Map([[100, "claudeAgent"], [200, "codex"]]));
    const health = createProcessHealth({ platform: "linux", pid: SERVER, limits: () => limits(), memoryLimitBytes: () => 4096 * MB, memoryUsedBytes: () => null, peaks: () => ({ pids: 197, memoryBytes: 1530 * MB }), fds: () => 61,
      turns: () => ({ running: 2, queued: 3, longestWaitMs: 41_400, most: 7, queuedEver: 9, starvedEver: 1 }),
      counts: () => ({ limit: 512, spawnFailed: { EAGAIN: 4, EMFILE: 0, ENFILE: 0, ENOMEM: 1, ENOENT: 2, other: 0 }, forceKilled: 3, lateReaped: 5 }) });
    health.sample(list, buckets);
    // agent-browser's daemon is no browser by name: it counts with the commands the server started, and its Chrome as the browser.
    const now = { procs: 15, threads: 126, zombies: 2, fds: 61, pidsUsed: 126, engines: { claudeAgent: 1, codex: 1 }, browser: 2, mcp: 3, shell: 3, other: 4 };
    expect(health.report()).toEqual({
      pid1: "init", reaper: "yes", serverIsPid1: false,
      limits: { pids: 512, memMB: 4096, nproc: "unlimited", shmMB: 64, gate: 512 },
      now, peak: now, kernelPeak: { pids: 197, memMB: 1530 },
      turns: { running: 2, queued: 3, longestWaitS: 41, most: 7 },
      since: { queued: 9, starved: 1, spawnFailed: { EAGAIN: 4, EMFILE: 0, ENFILE: 0, ENOMEM: 1, ENOENT: 2, other: 0 }, forceKilled: 3, lateReaped: 5 },
    });
    // A quieter minute later: now falls, the most stays.
    health.sample(list.slice(0, 3), classifyProcesses(list.slice(0, 3), SERVER, true));
    expect(health.report().now).toMatchObject({ procs: 3, threads: 19, zombies: 0, browser: 0, engines: {} });
    expect(health.report().peak).toEqual(now);
  });

  it("is unknown, never zero, where the system has no such files: macOS's process list, Windows with none at all", () => {
    const mac = createProcessHealth({ platform: "darwin", turns: () => quiet, counts: () => none, memoryLimitBytes: () => { throw new Error("not read off Linux"); } });
    expect(mac.report()).toMatchObject({ pid1: "unknown", reaper: "unknown", limits: { pids: "unknown", memMB: "unknown", nproc: "unknown", shmMB: "unknown", gate: "none" }, now: "unknown", peak: "unknown", kernelPeak: { pids: "unknown", memMB: "unknown" } });
    // ps gives macOS no thread counts or states: the processes are counted, the rest stays unknown.
    const plain = [{ pid: 5, ppid: 1, name: "node", cpuMs: 1, rssBytes: MB, start: "ps:5" }, { pid: 6, ppid: 5, name: "claude", cpuMs: 1, rssBytes: MB, start: "ps:6" }];
    mac.sample(plain, classifyProcesses(plain, 5, true));
    expect(mac.report().now).toEqual({ procs: 2, threads: "unknown", zombies: "unknown", fds: "unknown", pidsUsed: "unknown", engines: { claudeAgent: 1 }, browser: 0, mcp: 0, shell: 0, other: 0 });
    const windows = createProcessHealth({ platform: "win32", turns: () => quiet, counts: () => none });
    expect(windows.report()).toMatchObject({ pid1: "unknown", limits: { pids: "unknown", memMB: "unknown" }, now: "unknown", peak: "unknown", turns: { running: 0, queued: 0, most: "none" } });
    expect(processHealthLines(windows.report()).join("\n")).toContain("Now: unknown (no process list on this system)");
  });

  it("says once when the server nears its limit, and once when zombies pile up, naming where to read on", () => {
    const said: Array<[string, string]> = [];
    const health = createProcessHealth({ platform: "linux", limits: () => limits({ pidsCurrent: 420, pid1: "node", reaper: "no" }), memoryLimitBytes: () => null, fds: () => 30,
      turns: () => quiet, counts: () => none, warn: (kind, line) => said.push([kind, line]) });
    const zombies = [row(1, 0, "node"), ...Array.from({ length: 25 }, (_, index) => row(500 + index, 1, "sleep", 1, "Z"))];
    for (let sample = 0; sample < 3; sample++) health.sample(zombies, classifyProcesses(zombies, 1, true));
    expect(said.map(([kind]) => kind)).toEqual(["processes:near", "processes:zombies"]);
    expect(said[0]![1]).toBe('this server runs 420 processes and threads of the 512 its container allows (25 of them zombies). Past the limit nothing new can start; turns wait for room before that. See docs/self-hosting.md, "Running on a container platform".');
    expect(said[1]![1]).toContain("25 exited processes are waiting to be collected and nothing collects them");
    expect(health.startLine()).toBe("processes: process 1 is this app, with no init; limits: processes and threads 512, memory none, ulimit -u unlimited, /dev/shm 64 MB");
    const calm = createProcessHealth({ platform: "linux", limits: () => limits({ pidsCurrent: 100 }), memoryLimitBytes: () => null, fds: () => 30, turns: () => quiet, counts: () => none,
      warn: () => { throw new Error("nothing to say"); } });
    calm.sample(rows(), classifyProcesses(rows(), SERVER, true));
    // Memory: once past 80% of the container's limit, and never where no limit is set.
    const memory: Array<[string, string]> = [];
    let used = 3_000 * 1024 * 1024;
    const tight = createProcessHealth({ platform: "linux", limits: () => limits({ pidsCurrent: 100 }), memoryLimitBytes: () => 4096 * 1024 * 1024, memoryUsedBytes: () => used,
      fds: () => 30, turns: () => quiet, counts: () => none, warn: (kind, line) => memory.push([kind, line]) });
    tight.sample(rows(), classifyProcesses(rows(), SERVER, true));
    expect(memory).toEqual([]);
    used = 3_500 * 1024 * 1024;
    for (let sample = 0; sample < 3; sample++) tight.sample(rows(), classifyProcesses(rows(), SERVER, true));
    expect(memory).toEqual([["processes:memory", 'this server uses 3500 MB of the 4096 MB its container allows. Past the limit the kernel stops an engine; turns wait for room before that. See docs/self-hosting.md, "Running on a container platform".']]);
  });

  it("carries numbers and fixed words only: no executable's name, path, argument, bot or engine name a person chose", () => {
    const named: ProcessRow[] = [
      row(SERVER, 1, "node"),
      row(100, SERVER, "/users/ada/projects/acme-merger/bin/sk-ant-api03-privateprivateprivate1234567890"),
      row(101, 100, "https://intranet.acme.test/q?token=abc"), row(102, 100, "tallyspoon"), row(103, SERVER, "lookup_customer"),
      row(104, 1, "summarize the merger plan", 1, "Z"), row(105, SERVER, "ada@example.test"),
    ];
    // An engine kind that is no fixed word (a custom engine named by a person) reads as "unknown".
    const engines = new Map([[100, "Tallyspoon"], [103, "acme-internal"], [105, "hunter2-password"]]);
    const health = createProcessHealth({ platform: "linux", limits: () => limits(), memoryLimitBytes: () => 2048 * MB, memoryUsedBytes: () => null, peaks: () => ({ pids: 90, memoryBytes: null }), fds: () => 12, turns: () => quiet, counts: () => none });
    health.sample(named, classifyProcesses(named, SERVER, true, engines));
    const report = health.report();
    expect(report.now).toMatchObject({ engines: { unknown: 3 } });
    const sources: PerfSources = { hour: createTurnTimings({}).window(), day: createTurnTimings({}).day(), live: [], limits: null, process: null, processes: report };
    const texts = [JSON.stringify(report), JSON.stringify(perfHealth(sources)), perfLines(sources, [], "Latest turns:").join("\n"), processHealthLines(report).join("\n"), health.startLine()];
    for (const text of texts) expect(leaks(text)).toEqual([]);
    // Every string in the record is one of these words, or an engine kind from the server's own list.
    const strings: string[] = [];
    JSON.stringify(report, (_key, value) => { if (typeof value === "string") strings.push(value); if (value && typeof value === "object" && !Array.isArray(value)) strings.push(...Object.keys(value)); return value; });
    const fixed = new Set(["init", "node", "other", "unknown", "yes", "no", "max", "none", "unlimited", "pid1", "reaper", "serverIsPid1", "limits", "pids", "memMB", "nproc", "shmMB", "gate", "now", "peak", "kernelPeak",
      "procs", "threads", "zombies", "fds", "pidsUsed", "engines", "browser", "mcp", "shell", "turns", "running", "queued", "longestWaitS", "most", "since", "starved", "spawnFailed",
      "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "ENOENT", "forceKilled", "lateReaped"]);
    expect(strings.filter((word) => !fixed.has(word))).toEqual([]);
  });

  it("fits the health report's budget with every part at its fullest, giving up its own detail before the whole part", () => {
    const full = (count: number) => ({ procs: 99_999, threads: 999_999, zombies: 99_999, fds: 99_999, pidsUsed: 999_999, browser: 9_999, mcp: 9_999, shell: 9_999, other: 9_999,
      engines: Object.fromEntries(Array.from({ length: count }, (_, index) => [`someVeryLongEngineKindName${index}`, 9_999])) });
    const processes: ProcessHealth = { pid1: "unknown", reaper: "unknown", serverIsPid1: false, limits: { pids: 4_194_304, memMB: 1_048_576, nproc: 4_194_304, shmMB: 65_536, gate: 4_194_304 },
      now: full(8), peak: full(8), kernelPeak: { pids: 4_194_304, memMB: 1_048_576 }, turns: { running: 999, queued: 999, longestWaitS: 999_999, most: 999 },
      since: { queued: 999_999, starved: 999_999, spawnFailed: { EAGAIN: 999_999, EMFILE: 999_999, ENFILE: 999_999, ENOMEM: 999_999, ENOENT: 999_999, other: 999_999 }, forceKilled: 999_999, lateReaped: 999_999 } };
    const alone = JSON.stringify(processes).length;
    console.log(`process room, every part full: ${alone} bytes of the perf field's ${PERF_HEALTH_MAX_BYTES}`);
    expect(alone).toBeLessThan(1_400);
    expect(JSON.stringify(trimmedProcessHealth(processes)).length).toBeLessThan(alone / 2 + 200);
    expect(trimmedProcessHealth(processes)).toMatchObject({ peak: "unknown", since: processes.since, turns: processes.turns });
    expect(Object.keys((trimmedProcessHealth(processes).now as { engines: object }).engines)).toHaveLength(4);
    // The rest of the report at its fullest, as perf-privacy.test.ts builds it, leaves room for it.
    let clock = 1_800_000_000_000;
    const big = createTurnTimings({ now: () => clock });
    const kinds = ["mcp__browser__a", "mcp__computer__a", "Bash", "Read", "WebSearch", "WebFetch", "mcp__x__y", "remember", "routine", "publish_page", "show_widget", "delegate", "phone_tap", "TodoWrite", "generate_image", "mcp__data__q", "GMAIL_SEND_EMAIL", "anything"];
    for (let turn = 0; turn < 300; turn++) {
      const threadId = `thread_${turn}`;
      big.noteEvent({ eventId: "e", provider: "someVeryLongEngineKindName-abcdefghijk", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.started" });
      kinds.forEach((title, index) => big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "item.started", itemType: "tool", itemId: `i${index}`, title }));
      for (let retry = 0; retry < 4; retry++) big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.retrying", attempt: retry, delayMs: 1000, reason: `reason_${(turn * 4 + retry) % 20}` });
      big.noteEvent({ eventId: "e", provider: `engine${turn % 20}`, threadId, createdAt: "", turnId: `t${turn}`, type: "runtime.error", message: "m", limit: (["engine", "model", "credits"] as const)[turn % 3] });
      clock += 1_234_567;
      if (turn < 250) big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.completed", ok: turn % 2 === 0 });
    }
    clock = 1_800_000_000_000 + 250 * 1_234_567;
    const process = { at: clock, intervalS: 60, scope: "all" as const, samples: 60, browsers: 9, unseen60mS: 1234.5,
      buckets: Array.from({ length: 12 }, (_, index) => ({ bucket: `engine:someVeryLongEngineKindName${index}` as const, procs: 99, cpu5mS: 1234.5, cpu60mS: 12345.6, peakPct: 100, rssMB: 4096 })),
      loop: { eluPct: 100, eluMaxPct: 100, driftP95Ms: 123_456, driftMaxMs: 1_234_567 } };
    const body = perfHealth({ hour: big.window(), day: big.day(), live: big.live(), limits: null, process, processes });
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(body.processes).not.toBeNull();
    expect(body.processes!.since).toEqual(processes.since);
  });

  it("reads at most a fixed number of processes for a sample", () => {
    const names = Array.from({ length: MAX_SAMPLED_PROCESSES + 500 }, (_, index) => String(index + 1));
    let reads = 0;
    const list = linuxProcessList((path) => { if (/^\/proc\/\d+\/stat$/.test(path)) { reads += 1; return `${path.split("/")[2]} (node) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 7 0 5 0 10 0`; } return null; }, () => names);
    expect(list.rows).toHaveLength(MAX_SAMPLED_PROCESSES);
    expect(reads).toBe(MAX_SAMPLED_PROCESSES);
  });

  it("tallies a row outside every bucket as other, and nothing as the server's own", () => {
    const list = rows();
    expect(tally(list, new Map([[SERVER, "server"]]), 1, 2)).toMatchObject({ procs: 15, other: 14, browser: 0, mcp: 0, shell: 0, engines: {} });
  });
});
