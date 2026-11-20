import { describe, expect, it } from "vitest";
import { classifyProcesses, parseCgroupCpuMs, parseProcStat, parsePsLine, parsePsTime, parseReapedChildrenMs, type ProcessRow } from "./process-buckets.ts";
import { createProcessSampler, linuxProcessList, type ProcessList } from "./process-sampler.ts";

const SERVER = 100;
const row = (pid: number, ppid: number, name: string, cpuMs = 0, rssBytes = 1_048_576): ProcessRow => ({ pid, ppid, name, cpuMs, rssBytes, start: `s${pid}` });

/** /proc/<pid>/stat as the kernel writes it: utime, stime, starttime and rss at their places after the comm. */
const statLine = (pid: number, comm: string, ppid: number, utime: number, stime: number, rssPages = 256, cutime = 0, cstime = 0) =>
  `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 100 0 0 0 ${utime} ${stime} ${cutime} ${cstime} 20 0 1 0 5555 1000000 ${rssPages} 18446744073709551615`;

describe("process buckets, from the executable's name and parent only", () => {
  it("names the server, engines, browsers, a cloud computer, MCP servers, builds and a bot's commands", () => {
    const rows = [
      row(1, 0, "tini"), row(SERVER, 1, "node"), row(200, SERVER, "claude"), row(201, 200, "node"), row(202, 200, "bash"), row(203, 202, "python3"),
      row(204, 202, "pnpm"), row(205, 204, "node"), row(300, SERVER, "chrome"), row(301, 300, "chrome"), row(302, 1, "headless_shell"),
      row(400, 1, "xvfb"), row(401, SERVER, "uvx"), row(500, 1, "sshd"), row(600, SERVER, "codex"),
    ];
    const buckets = classifyProcesses(rows, SERVER, false);
    expect(Object.fromEntries(buckets)).toEqual({
      1: "other", 100: "server", 200: "engine:claudeAgent", 201: "mcp", 202: "commands", 203: "commands", 204: "build", 205: "build",
      300: "browser", 301: "browser", 302: "browser", 400: "computer", 401: "mcp", 500: "other", 600: "engine:codex",
    });
    const tree = classifyProcesses(rows, SERVER, true);
    expect([...tree.keys()].sort((a, b) => a - b)).toEqual([100, 200, 201, 202, 203, 204, 205, 300, 301, 401, 600]);
  });

  it("never takes a bucket from an object's prototype", () => {
    const rows = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].map((name, index) => row(200 + index, 1, name));
    expect(new Set(classifyProcesses(rows, SERVER, false).values())).toEqual(new Set(["other"]));
  });

  it("files a pid the server knows runs an engine under that engine, whatever its executable", () => {
    const rows = [row(SERVER, 1, "node"), row(200, SERVER, "node"), row(201, 200, "node"), row(202, SERVER, "node"), row(203, SERVER, "node")];
    const buckets = classifyProcesses(rows, SERVER, true, new Map([[200, "geminiAgent"], [203, "claude --key sk-x"]]));
    expect(Object.fromEntries(buckets)).toEqual({ 100: "server", 200: "engine:geminiAgent", 201: "mcp", 202: "mcp", 203: "engine:unknown" });
  });

  it("survives a parent loop and a missing parent", () => {
    expect(Object.fromEntries(classifyProcesses([row(7, 8, "a"), row(8, 7, "b"), row(9, 999, "bash")], SERVER, false))).toEqual({ 7: "other", 8: "other", 9: "other" });
  });

  it("parses /proc stat lines (a comm with spaces and parentheses), ps lines and CPU counters", () => {
    expect(parseProcStat(42, statLine(42, "Web Content (x)", 7, 150, 50))).toEqual({ pid: 42, ppid: 7, name: "web content (x)", cpuMs: 2_000, rssBytes: 256 * 4096, start: "5555", threads: 1, state: "S", pgid: 42, sid: 42 });
    expect(parseProcStat(1, "garbage")).toBeNull();
    expect(parseReapedChildrenMs(statLine(1, "node", 0, 0, 0, 1, 300, 200))).toBe(5_000);
    expect(parsePsTime("1:02.50")).toBe(62_500);
    expect(parsePsTime("2-01:00:00")).toBe((49 * 3600) * 1000);
    expect(parsePsTime("nope")).toBeNull();
    expect(parsePsLine("  812     1  20480   0:03.10 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)"))
      .toEqual({ pid: 812, ppid: 1, name: "google chrome helper (renderer)", cpuMs: 3_100, rssBytes: 20480 * 1024, start: "ps:812" });
    expect(parsePsLine("  812     1   640  20480   0:03.10 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)"))
      .toEqual({ pid: 812, ppid: 1, name: "google chrome helper (renderer)", cpuMs: 3_100, rssBytes: 20480 * 1024, start: "ps:812", pgid: 640 });
    expect(parseCgroupCpuMs("usage_usec 2500000\nuser_usec 1\n", null)).toBe(2_500);
    expect(parseCgroupCpuMs(null, "7000000000\n")).toBe(7_000);
    expect(parseCgroupCpuMs(null, null)).toBeNull();
  });

  it("reads every process /proc lists, and nothing but each one's stat line", () => {
    const read: string[] = [];
    const files: Record<string, string> = {
      "/proc/100/stat": statLine(100, "node", 1, 10, 10), "/proc/200/stat": statLine(200, "claude", 100, 20, 0),
      "/proc/self/stat": statLine(100, "node", 1, 10, 10, 1, 7, 3), "/sys/fs/cgroup/cpu.stat": "usage_usec 9000000\n",
    };
    const list = linuxProcessList((path) => { read.push(path); return files[path] ?? null; }, () => ["100", "200", "self", "stat", "300"]);
    expect(list.rows.map((entry) => entry.name)).toEqual(["node", "claude"]);
    expect(list).toMatchObject({ reapedMs: 100, totalMs: 9_000 });
    expect(read.every((path) => /^\/proc\/(\d+|self)\/stat$|^\/sys\/fs\/cgroup\//.test(path))).toBe(true);
  });
});

describe("the sampler", () => {
  it("answers who used the CPU in the last five and sixty minutes, with each bucket's peak", async () => {
    let clock = 1_800_000_000_000, mono = 0;
    let lists: ProcessList[] = [];
    const sampler = createProcessSampler({ list: () => lists.shift() ?? null, intervalMs: 60_000, scope: "all", serverPid: SERVER, now: () => clock, monotonic: () => mono, utilization: () => 0.05 });
    const step = async (rows: ProcessRow[], totalMs: number | null = null, reapedMs: number | null = null) => {
      lists = [{ rows, totalMs, reapedMs }];
      await sampler.sampleNow();
      clock += 60_000; mono += 60_000;
    };
    // An idle server, and once every five minutes a minute of one full core in a build.
    let serverCpu = 0, buildCpu = 0, total = 0;
    for (let minute = 0; minute <= 60; minute++) {
      serverCpu += 600; total += 600;
      const building = minute % 5 === 1;
      if (building) { buildCpu += 60_000; total += 60_000; }
      const rows = [row(SERVER, 1, "node", serverCpu), row(200, SERVER, "claude", 1_000)];
      if (building) rows.push(row(900 + minute, 200, "make", 60_000));
      await step(rows, total + 1_000 * minute, null);
    }
    clock -= 60_000;
    const report = sampler.report();
    const byName = Object.fromEntries(report.buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(byName.build).toMatchObject({ cpu60mS: 720, peakPct: 100, procs: 0 });
    expect(byName.server).toMatchObject({ cpu60mS: 36, cpu5mS: 3, peakPct: 1, procs: 1, rssMB: 1 });
    expect(byName["engine:claudeAgent"]).toMatchObject({ cpu60mS: 0, procs: 1 });
    expect(report.buckets[0]!.bucket).toBe("build");
    expect(report.unseen60mS).toBe(60);
    expect(report.loop).toMatchObject({ eluPct: 5, eluMaxPct: 5 });
    expect(report).toMatchObject({ scope: "all", intervalS: 60, samples: 60, browsers: 0 });
    expect(JSON.stringify(report)).not.toMatch(/make|claude"|node/);
  });

  it("counts CPU of a server child that came and went between samples, and browsers by instance", async () => {
    let lists: ProcessList[] = [];
    let clock = 0;
    const sampler = createProcessSampler({ list: () => lists.shift() ?? null, intervalMs: 60_000, scope: "tree", serverPid: SERVER, now: () => clock, monotonic: () => clock });
    lists = [{ rows: [row(SERVER, 1, "node"), row(210, SERVER, "bash", 1_000)], reapedMs: 0, totalMs: null }];
    await sampler.sampleNow();
    clock += 60_000;
    lists = [{ rows: [row(SERVER, 1, "node"), row(300, SERVER, "chrome"), row(301, 300, "chrome"), row(302, SERVER, "chromium")], reapedMs: 9_000, totalMs: null }];
    await sampler.sampleNow();
    const report = sampler.report();
    expect(report.buckets.find((bucket) => bucket.bucket === "commands")).toMatchObject({ cpu60mS: 8 });
    expect(report.browsers).toBe(2);
    expect(report.unseen60mS).toBeNull();
  });
});

describe("the sampler's cost", () => {
  it("parses, classifies and diffs 500 processes in well under a few milliseconds", async () => {
    const stats = Array.from({ length: 500 }, (_, index) => statLine(1000 + index, index % 7 ? "node" : "chrome", index ? 1000 + Math.floor(index / 3) : SERVER, index, index));
    let rounds = 0;
    const sampler = createProcessSampler({ intervalMs: 60_000, scope: "all", serverPid: SERVER, list: () => ({ rows: stats.flatMap((text, index) => {
      const parsed = parseProcStat(1000 + index, text);
      return parsed ? [{ ...parsed, cpuMs: parsed.cpuMs + rounds * 10 }] : [];
    }), reapedMs: null, totalMs: null }) });
    const started = performance.now();
    for (; rounds < 50; rounds++) await sampler.sampleNow();
    const each = (performance.now() - started) / 50;
    console.log(`process sample of 500 rows: ${each.toFixed(2)} ms (stat files already read)`);
    expect(each).toBeLessThan(25);
    expect(sampler.report().buckets.length).toBeGreaterThan(0);
  });
});
