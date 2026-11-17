import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { runInTurn } from "../crash-guard.ts";
import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { EngineOwners } from "../engine-owners.ts";
import { footprintOwners } from "../host/bot-footprint-owners.ts";
import { BOT_FOOTPRINT_PATH, createPerfDiagnosticsRoutes } from "../routes/perf-diagnostics.ts";
import { PASS, type RouteContext } from "../routes/table.ts";
import { attributeRows, botFootprintLines, createBotFootprints, type FootprintOwner } from "./bot-footprint.ts";
import { parsePsLine, type ProcessRow } from "./process-buckets.ts";
import { linuxProcessList } from "./process-sampler.ts";
import { perfHealth, PERF_HEALTH_MAX_BYTES } from "./perf-report.ts";
import { createTurnTimings } from "./turn-timings.ts";

const MB = 1_048_576;
const PAGE = 4096;

/** /proc/<pid>/stat as the kernel writes it: state, ppid, pgrp, session, …, utime, stime, …, threads, …, starttime, vsize, rss. */
const stat = (pid: number, comm: string, ppid: number, { pgid = pid, sid = pid, cpuTicks = 0, threads = 1, start = 1000 + pid, rssMB = 10, state = "S" } = {}) =>
  `${pid} (${comm}) ${state} ${ppid} ${pgid} ${sid} 0 -1 4194304 100 0 0 0 ${cpuTicks} 0 0 0 20 0 ${threads} 0 ${start} 1000000 ${(rssMB * MB) / PAGE} 18446744073709551615`;

/** A fake /proc: what linuxProcessList reads, and only that (no real /proc on a Mac or Windows test run). */
function fakeProc(lines: Record<number, string>) {
  const files: Record<string, string> = Object.fromEntries(Object.entries(lines).map(([pid, line]) => [`/proc/${pid}/stat`, line]));
  return linuxProcessList((path) => files[path] ?? null, () => Object.keys(lines)).rows;
}

const SERVER = 100;
/** Bot A: engine 200 (a tool server 201, a shell 202 whose background child 203 was adopted by init when the shell exited)
 * and its browser's daemon 500 (a session of its own) with Chrome 501–502. Bot B: engine 300 with a tool server 301.
 * A shared ACP process 400 serving A and B, with a tool server 401; a profile browser 600 that A and B both use, with
 * Chrome 601. The server, init and an unrelated process 900 belong to no bot. */
function server() {
  return fakeProc({
    1: stat(1, "tini", 0, { pgid: 1, sid: 1 }),
    [SERVER]: stat(SERVER, "node", 1, { pgid: 1, sid: 1, rssMB: 200, threads: 11 }),
    200: stat(200, "claude", SERVER, { rssMB: 300, threads: 12, cpuTicks: 500 }),
    201: stat(201, "node", 200, { pgid: 200, sid: 200, rssMB: 50, threads: 7 }),
    202: stat(202, "bash", 200, { pgid: 200, sid: 200, rssMB: 4 }),
    203: stat(203, "sleep", 1, { pgid: 200, sid: 200, rssMB: 1 }),
    300: stat(300, "codex", SERVER, { rssMB: 120, threads: 20, cpuTicks: 100 }),
    301: stat(301, "node", 300, { pgid: 300, sid: 300, rssMB: 40, threads: 7 }),
    400: stat(400, "opencode", SERVER, { rssMB: 400, threads: 30 }),
    401: stat(401, "node", 400, { pgid: 400, sid: 400, rssMB: 30 }),
    500: stat(500, "agent-browser", 1, { rssMB: 20, threads: 5 }),
    501: stat(501, "chrome", 500, { pgid: 500, sid: 500, rssMB: 200, threads: 40 }),
    502: stat(502, "chrome", 501, { pgid: 500, sid: 500, rssMB: 100, threads: 20 }),
    600: stat(600, "agent-browser", 1, { rssMB: 20 }),
    601: stat(601, "chrome", 600, { pgid: 600, sid: 600, rssMB: 250 }),
    900: stat(900, "postgres", 1, { rssMB: 500 }),
  });
}
const OWNERS: FootprintOwner[] = [
  { pid: 200, start: "1200", botIds: ["bot_a"], kind: "engine" },
  { pid: 300, start: "1300", botIds: ["bot_b"], kind: "engine" },
  { pid: 400, start: "1400", botIds: ["bot_a", "bot_b"], kind: "engine" },
  { pid: 500, botIds: ["bot_a"], kind: "browser" },
  { pid: 600, botIds: ["bot_a", "bot_b"], kind: "browser" },
];

describe("a bot's footprint, from a process list", () => {
  it("counts each bot's engine tree, what outlived its parent in the engine's session, and its own browser", () => {
    const { bots, shared } = attributeRows(server(), OWNERS);
    expect(Object.fromEntries([...bots].map(([id, tally]) => [id, { procs: tally.procs, threads: tally.threads, mb: tally.rssBytes / MB, engines: tally.engines, browsers: tally.browsers, pids: tally.pids.sort((a, b) => a - b) }]))).toEqual({
      bot_a: { procs: 7, threads: 12 + 7 + 1 + 1 + 5 + 40 + 20, mb: 300 + 50 + 4 + 1 + 20 + 200 + 100, engines: 1, browsers: 1, pids: [200, 201, 202, 203, 500, 501, 502] },
      bot_b: { procs: 2, threads: 27, mb: 160, engines: 1, browsers: 0, pids: [300, 301] },
    });
    // A process that serves both bots is neither bot's.
    expect(shared).toMatchObject({ procs: 4, rssBytes: (400 + 30 + 20 + 250) * MB, engines: 1, browsers: 1 });
    expect(shared.pids.sort((a, b) => a - b)).toEqual([400, 401, 600, 601]);
  });

  it("never counts another bot's processes: a shared or unknown record makes its tree shared, and a reused pid is no one's", () => {
    const rows = server();
    // Engine 300's pid now belongs to a process that started later: not bot B's engine any more.
    const reused = attributeRows(rows, [{ pid: 300, start: "999", botIds: ["bot_b"], kind: "engine" }]);
    expect(reused.bots.size).toBe(0);
    expect(reused.shared.procs).toBe(0);
    // Two records of one pid naming different bots, or one naming something that is not a bot id: shared.
    const twice = attributeRows(rows, [{ pid: 200, botIds: ["bot_a"], kind: "engine" }, { pid: 200, botIds: ["bot_b"], kind: "engine" }]);
    expect(twice.bots.size).toBe(0);
    expect(twice.shared.procs).toBe(4);
    expect(attributeRows(rows, [{ pid: 300, botIds: ["?"], kind: "engine" }]).bots.size).toBe(0);
    expect(attributeRows(rows, [{ pid: 300, botIds: [], kind: "engine" }]).shared.procs).toBe(2);
  });

  it("still counts what an engine left in its session after the engine itself exited", () => {
    const rows = server().filter((row) => row.pid !== 200);
    const { bots } = attributeRows(rows, OWNERS);
    // 201 and 202 lost their parent too; all three still run in engine 200's session.
    expect(bots.get("bot_a")?.pids.filter((pid) => pid < 500).sort((a, b) => a - b)).toEqual([201, 202, 203]);
    expect(bots.get("bot_a")?.engines).toBe(0);
  });

  it("works from macOS's ps list: groups, no sessions, no thread counts", () => {
    const rows = [
      "  100     1     100  204800   0:01.00 /usr/local/bin/node",
      "  200   100     200  307200   0:05.00 /usr/local/bin/claude",
      "  201   200     200   51200   0:00.50 /usr/local/bin/node",
      "  203     1     200    1024   0:00.00 /bin/sleep",
      "  900     1     900  512000   0:09.00 /usr/local/bin/postgres",
    ].map((line) => parsePsLine(line)!);
    const { bots } = attributeRows(rows, [{ pid: 200, botIds: ["bot_a"], kind: "engine" }]);
    expect(bots.get("bot_a")).toMatchObject({ procs: 3, threads: null, rssBytes: (300 + 50 + 1) * MB, cpuMs: 5_500 });
  });

  it("reports memory first, with each bot's most and its share of a core since the previous sample", () => {
    let clock = 1_800_000_000_000;
    let rows = server();
    const footprints = createBotFootprints({ owners: () => OWNERS, now: () => clock });
    expect(footprints.report().at).toBeNull();
    expect(botFootprintLines(footprints.report())).toEqual(["Per bot: not sampled yet"]);
    footprints.sample(rows);
    clock += 60_000;
    // A minute later: bot B's engine used 30 s of CPU, and bot A's browser closed.
    rows = rows.filter((row) => row.pid < 500 || row.pid >= 600).map((row) => (row.pid === 300 ? { ...row, cpuMs: row.cpuMs + 30_000 } : row));
    footprints.sample(rows);
    const report = footprints.report();
    expect(report).toMatchObject({ at: clock, bots: 2, shown: [
      { id: "bot_a", procs: 4, rssMB: 355, peakMB: 675, cpuPct: 0, engines: 1, browsers: 0 },
      { id: "bot_b", procs: 2, rssMB: 160, peakMB: 160, cpuS: 31, cpuPct: 50 },
    ], shared: { procs: 4, rssMB: 700 } });
    expect(footprints.report(1).shown.map((row) => row.id)).toEqual(["bot_a"]);
    expect(botFootprintLines(report)[0]).toMatch(/^Per bot \(2 with processes running; most memory first\): bot bot_a 4 processes, 21 threads, 355 MB \(most 675 MB\)/);
  });

  it("lets records of exited engines go once nothing runs in their group or session", () => {
    const pruned: number[][] = [];
    const footprints = createBotFootprints({ owners: () => OWNERS, prune: (rows) => pruned.push(rows.map((row) => row.pid).filter((pid) => pid === 200 || pid === 777)) });
    footprints.sample(server());
    expect(pruned).toEqual([[200]]);
  });
});

describe("which bot an engine runs for", () => {
  it("records the turn's bot at spawn, conversations that attach and detach, and keeps an exited engine until pruned", () => {
    const owners = new EngineOwners();
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    runInTurn({ botId: "bot_a", threadId: "thread_1" }, () => owners.track(child, "777"));
    expect(owners.list()).toEqual([{ pid: 4242, start: "777", threads: new Map([["thread_1", "bot_a"]]), exited: false, shareable: false }]);
    // A shared ACP process marks itself one other conversations may join.
    owners.shareable(child);
    expect(owners.list()[0]?.shareable).toBe(true);
    runInTurn({ botId: "bot_b", threadId: "thread_2" }, () => owners.attach(child, "thread_2"));
    owners.attach(child, "thread_3");
    expect([...owners.list()[0]!.threads]).toEqual([["thread_1", "bot_a"], ["thread_2", "bot_b"], ["thread_3", ""]]);
    owners.detach(child, "thread_2");
    child.emit("exit", 0, null);
    expect(owners.list()[0]).toMatchObject({ exited: true });
    // Something it left still runs in its session.
    owners.prune([{ pid: 4300, start: "900", pgid: 4242, sid: 4242 }]);
    expect(owners.list()).toHaveLength(1);
    owners.prune([{ pid: 1, start: "1" }]);
    expect(owners.list()).toHaveLength(0);
    // Outside a turn (a keep-warm ping): no conversation, so shared until one attaches.
    owners.track(Object.assign(new EventEmitter(), { pid: 4243 }), null);
    expect(owners.list()[0]?.threads.size).toBe(0);
  });

  it("names a conversation's bot from the store; a group's room, a turn of another bot, or no known bot makes it shared", () => {
    const owners = new EngineOwners();
    const child = Object.assign(new EventEmitter(), { pid: 10 });
    owners.track(child, null);
    owners.attach(child, "thread_known");
    const browsers: FootprintOwner[] = [{ pid: 11, botIds: ["bot_z"], kind: "browser" }];
    const botOf = (threadId: string) => (threadId === "thread_known" || threadId === "thread_k2" ? "bot_k" : null);
    const list = footprintOwners({ botOf, browsers: () => browsers, engines: owners });
    expect(list()).toEqual([{ pid: 10, start: null, kind: "engine", botIds: ["bot_k"], threads: ["thread_known"] }, browsers[0]]);
    owners.attach(child, "thread_gone");
    expect(list()[0]?.botIds).toEqual(["bot_k", "?"]);
    const rows: ProcessRow[] = [{ pid: 10, ppid: 1, name: "opencode", cpuMs: 0, rssBytes: MB, start: "s" }];
    expect(attributeRows(rows, list()).bots.size).toBe(0);
    // A group's room: several bots take turns in one conversation, which belongs to no bot.
    const room = new EngineOwners();
    runInTurn({ botId: "bot_k", threadId: "group_thread" }, () => room.track(Object.assign(new EventEmitter(), { pid: 20 }), null));
    expect(footprintOwners({ botOf, browsers: () => [], engines: room })()[0]?.botIds).toEqual(["?", "bot_k"]);
    // A turn of another bot in a bot's own conversation.
    const visit = new EngineOwners();
    runInTurn({ botId: "bot_v", threadId: "thread_k2" }, () => visit.track(Object.assign(new EventEmitter(), { pid: 30 }), null));
    const visited = footprintOwners({ botOf, browsers: () => [], engines: visit })();
    expect(visited[0]?.botIds).toEqual(["bot_k", "bot_v"]);
    expect(attributeRows([{ pid: 30, ppid: 1, name: "claude", cpuMs: 0, rssBytes: MB, start: "s" }], visited).shared.procs).toBe(1);
  });

  it("retires an exited engine the first time its pid shows as another process, and keeps it retired once that one exits", () => {
    const owners = new EngineOwners();
    const child = Object.assign(new EventEmitter(), { pid: 200 });
    runInTurn({ botId: "bot_a", threadId: "thread_a" }, () => owners.track(child, "1200"));
    const list = footprintOwners({ botOf: () => "bot_a", browsers: () => [], engines: owners });
    child.emit("exit", 0, null);
    // What the engine left still runs in its session: kept.
    const left = fakeProc({ [SERVER]: stat(SERVER, "node", 1, { pgid: 1, sid: 1 }), 203: stat(203, "sleep", 1, { pgid: 200, sid: 200 }) });
    owners.prune(left);
    expect(attributeRows(left, list()).bots.get("bot_a")?.pids).toEqual([203]);
    // Later the system gives 200 to another program, which leads its own session and starts a child there.
    const reused = fakeProc({ 200: stat(200, "postgres", 1, { start: 99_000 }), 210: stat(210, "postgres", 200, { pgid: 200, sid: 200 }) });
    owners.prune(reused);
    expect(owners.list()).toHaveLength(0);
    // That program exits, its child (adopted by init) still in session 200: nothing of it is bot A's.
    const after = fakeProc({ 210: stat(210, "postgres", 1, { pgid: 200, sid: 200 }) });
    owners.prune(after);
    expect(attributeRows(after, list()).bots.size).toBe(0);
    // Off Linux no start was read: the pid seen in two lists after the engine was reaped is another process's.
    const mac = new EngineOwners();
    const engine = Object.assign(new EventEmitter(), { pid: 300 });
    runInTurn({ botId: "bot_b", threadId: "thread_b" }, () => mac.track(engine, null));
    engine.emit("exit", 0, null);
    const row = { pid: 300, start: "ps:300", pgid: 300 };
    mac.prune([row]);
    expect(mac.list()).toHaveLength(1);
    mac.prune([row]);
    expect(mac.list()).toHaveLength(0);
  });

  it("never names a process by an exited engine's pid, which may be another process's now", () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, name: "postgres", cpuMs: 0, rssBytes: MB, start: "ps:200", pgid: 200 },
      { pid: 201, ppid: 1, name: "sleep", cpuMs: 0, rssBytes: MB, start: "ps:201", pgid: 777 },
    ];
    const { bots } = attributeRows(rows, [{ pid: 200, botIds: ["bot_a"], kind: "engine", exited: true }, { pid: 777, botIds: ["bot_a"], kind: "engine", exited: true }]);
    expect(bots.get("bot_a")?.pids).toEqual([201]);
    expect(bots.get("bot_a")?.engines).toBe(0);
  });
});

describe("where the footprint shows", () => {
  it("rides in the health report's perf part (ids and numbers only) and shrinks before anything else is dropped", () => {
    const timings = createTurnTimings({ now: () => 1_800_000_000_000 });
    const footprints = createBotFootprints({ owners: () => OWNERS });
    footprints.sample(server());
    const body = perfHealth({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: null, process: null, bots: footprints.report(10) });
    expect(body.bots?.shown.map((row) => Object.keys(row).sort())).toEqual([
      ["browsers", "cpuPct", "cpuS", "engines", "id", "peakMB", "procs", "rssMB", "threads"], ["browsers", "cpuPct", "cpuS", "engines", "id", "peakMB", "procs", "rssMB", "threads"]]);
    expect(JSON.stringify(body.bots)).not.toMatch(/claude|codex|chrome|postgres|node/);
    const many = { at: 1, bots: 100, shared: { procs: 1, threads: 1, rssMB: 1, cpuS: 1, cpuPct: 1, engines: 1, browsers: 1 },
      shown: Array.from({ length: 200 }, (_, index) => ({ id: `bot_${"x".repeat(56)}${index}`, procs: 999, threads: 9999, rssMB: 99999, peakMB: 99999, cpuS: 99999.9, cpuPct: 100, engines: 9, browsers: 1 })) };
    const trimmed = perfHealth({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: null, process: null, bots: many });
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(trimmed.bots?.shown).toHaveLength(3);
  });

  it("answers GET /api/diagnostics/bots with every bot, and passes other requests on", async () => {
    const footprints = createBotFootprints({ owners: () => OWNERS });
    footprints.sample(server());
    const route = createPerfDiagnosticsRoutes({ text: () => "", bots: () => footprints.report() });
    const sent: unknown[] = [];
    const context = (path: string, method = "GET") => ({ path, method, res: { setHeader: () => undefined }, json: (_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); } }) as unknown as RouteContext;
    // Admin only: never a client session, never a bot's shell on service-trust loopback.
    expect(requiredScope("GET", BOT_FOOTPRINT_PATH)).toBe("admin");
    expect(serviceAllowed("GET", BOT_FOOTPRINT_PATH)).toBe(false);
    expect(await route(context(BOT_FOOTPRINT_PATH, "POST"))).toBe(PASS);
    await route(context(BOT_FOOTPRINT_PATH));
    expect(sent).toEqual([{ status: 200, body: { bots: footprints.report() } }]);
  });
});
