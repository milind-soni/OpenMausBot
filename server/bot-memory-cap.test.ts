// The per-bot memory cap (bot-memory-cap.ts): watch only by default; a set number acts, only under pressure, on the bot
// using the most, in steps.
import { describe, expect, it } from "vitest";

import {
  BOT_CAP_FLOOR_BYTES, BotMemoryWatchdog, botMemoryCap, capLadder, OVER_FOR_MS, pssBytes, useBotMemoryWatchdog, withBotMemoryCap,
  type CapPressure, type CapSetting,
} from "./bot-memory-cap.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "./contracts.ts";
import { stoppedForRoom } from "./drivers/session-idle.ts";
import { memoryStopped } from "./engine-memory.ts";
import { hostFaultOf, retryCannotFix } from "./host-fault.ts";
import { capPressure } from "./host/bot-memory-cap-host.ts";
import type { FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";
import { perfHealth, PERF_HEALTH_MAX_BYTES } from "./perf/perf-report.ts";
import { createTurnTimings } from "./perf/turn-timings.ts";
import { namesOwnCause } from "./process-shortage.ts";
import { retriesTeammateThread } from "./routine-recovery.ts";

const MB = 1024 * 1024, GB = 1024 * MB;
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("the cap's setting", () => {
  const inputs = (memoryBytes: number, turns?: number) => ({ gate: "server" as const, memoryBytes, ...(turns === undefined ? {} : { turns }) });

  it("watches only by default, enforces only a set number, and is off where set off or on the desktop unless set", () => {
    const warned: string[] = [];
    expect(botMemoryCap({}, { gate: null, memoryBytes: 16 * GB })).toBeNull();
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "3000" }, { gate: null, memoryBytes: 16 * GB })).toEqual({ mode: "enforce", bytes: 3000 * MB });
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "off" }, inputs(8 * GB, 10))).toBeNull();
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "0" }, inputs(8 * GB, 10))).toBeNull();
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "10" }, inputs(8 * GB, 10))).toEqual({ mode: "enforce", bytes: 256 * MB });
    // 8 GB and 10 turns: a fair share is 819 MB, twice that 1,638 MB, below an engine at its largest with its browser.
    expect(botMemoryCap({}, inputs(8 * GB, 10))).toEqual({ mode: "log", bytes: BOT_CAP_FLOOR_BYTES });
    expect(BOT_CAP_FLOOR_BYTES).toBe(1900 * MB);
    // "auto" is the default: watch only, with the computed value. 32 GB and 8 turns: 8 GB.
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "auto" }, inputs(32 * GB, 8))).toEqual({ mode: "log", bytes: 8 * GB });
    expect(botMemoryCap({}, inputs(2 * GB, 2))?.bytes).toBe(Math.round(1.6 * GB));
    expect(botMemoryCap({}, inputs(64 * GB))?.bytes).toBe(BOT_CAP_FLOOR_BYTES);
    expect(botMemoryCap({ OMB_BOT_MEMORY_MAX_MB: "lots" }, inputs(8 * GB, 10), (line) => warned.push(line))).toEqual({ mode: "log", bytes: BOT_CAP_FLOOR_BYTES });
    expect(warned).toEqual(['OMB_BOT_MEMORY_MAX_MB="lots" is not a number of MB, "auto" or "off", so the default (watch only) is used']);
  });

  it("reports the ladder's rungs this host offers, and watches with the watchdog", () => {
    const log: CapSetting = { mode: "log", bytes: GB };
    expect(capLadder(log, { platform: "darwin" })).toEqual({ rung: "none", offered: [] });
    const files: Record<string, string> = { "/proc/self/cgroup": "0::/system.slice/openmausbot.service\n", "/sys/fs/cgroup/system.slice/openmausbot.service/cgroup.controllers": "cpu io memory pids\n" };
    const read = (path: string) => files[path] ?? null;
    expect(capLadder(log, { platform: "linux", read, writable: () => true, exists: () => true })).toEqual({ rung: "watchdog", offered: ["systemd-scope", "cgroup", "watchdog"] });
    expect(capLadder(log, { platform: "linux", read: (path) => (path === "/proc/self/cgroup" ? "0::/\n" : path === "/sys/fs/cgroup/cgroup.controllers" ? "memory pids\n" : null), writable: () => false, exists: () => false }))
      .toEqual({ rung: "watchdog", offered: ["watchdog"] });
    expect(capLadder(null, { platform: "linux", read, writable: () => false, exists: () => false })).toEqual({ rung: "none", offered: ["watchdog"] });
    expect(pssBytes(7, (path) => (path === "/proc/7/smaps_rollup" ? "Rss:  2048 kB\nPss:   1024 kB\n" : null))).toBe(MB);
    expect(pssBytes(7, () => null)).toBeNull();
  });

  it("reads pressure from engine-memory where the gate runs, else from memory directly", () => {
    const host = (availableGB: number) => () => ({ totalBytes: 16 * GB, availableBytes: availableGB * GB, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 });
    expect(capPressure({ enabled: true, roomFactor: () => 0.2 }, host(1))).toEqual({ room: 0.2, short: true, freeBytes: GB });
    // The pids limit alone lowers the room factor, never "short": a stopped turn's line says memory ran short.
    expect(capPressure({ enabled: true, roomFactor: () => 0.1 }, host(12))).toEqual({ room: 0.1, short: false, freeBytes: 12 * GB });
    expect(capPressure({ enabled: false, roomFactor: () => 1 }, host(12))).toMatchObject({ room: 1, short: false });
    // 1 GB free of 16 GB: below the 1.6 GB floor, so short; a tenth of the room.
    expect(capPressure({ enabled: false, roomFactor: () => 1 }, host(1))).toMatchObject({ room: 0.1, short: true });
    expect(capPressure({ enabled: false, roomFactor: () => 1 }, () => null)).toEqual({ room: 1, short: false, freeBytes: null });
  });
});

/** Bot A: engine 200 (conversation ta) and its tool server 201 (900 MB: under its cap). Bot B: engine 300 (tb) with tool server 301, its browser
 * 500 (session bot-b) with Chrome 501; with `two`, a second engine 310 (tc) and its tool server 311; with `orphan`,
 * what an exited engine 320 left in its session (321). Shared: an engine 400 both bots use. Sizes in MB. */
function processes(sizes: { a?: number; b?: number; b2?: number; orphan?: number; browser?: number; shared?: number } = {}) {
  const row = (pid: number, ppid: number, mb: number, pgid = pid): ProcessRow => ({ pid, ppid, name: "x", cpuMs: 0, rssBytes: mb * MB, start: `s${pid}`, pgid, sid: pgid });
  const browser = sizes.browser ?? 100;
  return [
    row(100, 1, 200),
    row(200, 100, (sizes.a ?? 900) - 200), row(201, 200, 200, 200),
    row(300, 100, (sizes.b ?? 600) - 100), row(301, 300, 100, 300),
    ...(sizes.b2 ? [row(310, 100, sizes.b2 - 100), row(311, 310, 100, 310)] : []),
    ...(sizes.orphan ? [row(321, 1, sizes.orphan, 320)] : []),
    row(500, 1, browser * 0.4), row(501, 500, browser * 0.6, 500),
    row(400, 100, sizes.shared ?? 5000),
  ];
}
const OWNERS: FootprintOwner[] = [
  { pid: 200, botIds: ["bot_a"], kind: "engine", threads: ["ta"] }, { pid: 300, botIds: ["bot_b"], kind: "engine", threads: ["tb"] },
  { pid: 310, botIds: ["bot_b"], kind: "engine", threads: ["tc"] }, { pid: 320, botIds: ["bot_b"], kind: "engine", threads: ["td"], exited: true },
  { pid: 500, botIds: ["bot_b"], kind: "browser", session: "bot-b" }, { pid: 400, botIds: ["bot_a", "bot_b"], kind: "engine", threads: ["ta", "tb"] },
];
const ROOMY: CapPressure = { room: 1, short: false, freeBytes: 40 * GB };
const SHORT: CapPressure = { room: 0.1, short: true, freeBytes: 300 * MB };

/** A watchdog over `rows` with a 1,000 MB cap per engine. Every process's proportional size reads as its resident size. */
function dog(rows: () => ProcessRow[], options: {
  mode?: CapSetting["mode"]; pressure?: () => CapPressure; busy?: ReadonlySet<string>; owners?: () => FootprintOwner[];
  pss?: (pid: number) => number | null; startOf?: (pid: number) => string | null;
} = {}) {
  const signals: string[] = [], closed: string[][] = [], logs: string[] = [];
  let clock = 1_800_000_000_000, pssReads = 0;
  const pss = options.pss ?? ((pid: number) => rows().find((row) => row.pid === pid)?.rssBytes ?? null);
  const watchdog = new BotMemoryWatchdog({
    cap: () => ({ mode: options.mode ?? "enforce", bytes: 1000 * MB }), list: rows, owners: options.owners ?? (() => OWNERS), pressure: options.pressure ?? (() => SHORT),
    pss: (pid) => { pssReads += 1; return pss(pid); }, startOf: options.startOf ?? ((pid) => `s${pid}`), graceMs: 0, now: () => clock,
    busy: (threadId) => (options.busy ?? new Set(["tb", "ta"])).has(threadId),
    signal: (pid, value) => signals.push(`${value} ${pid}`), closeBrowsers: async (threadIds) => { closed.push([...threadIds]); }, log: (line) => logs.push(line),
  });
  return { watchdog, signals, closed, logs, pssReads: () => pssReads, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("watch only, the default", () => {
  it("writes down a bot over its cap (once while it stays over) and sends no signal, closes no browser, explains nothing", async () => {
    // Bot B at 1,700 MB against 1,000 MB, memory short: an opt-in cap would act.
    let sizes = { b: 1600 };
    const h = dog(() => processes(sizes), { mode: "log" });
    const [event] = await h.watchdog.check();
    expect(event).toEqual({ at: h.now(), botId: "bot_b", usedMB: 1700, measured: "pss", capMB: 1000, engines: 1, room: 0.1, freeMB: 300, pressure: true, action: "logged" });
    expect(h.logs).toEqual(["memory: bot bot_b uses 1700 MB (proportional), over the 1000 MB one bot may use with 1 engine running; room 0.1, 300 MB free: "
      + "watch only, nothing stopped (set OMB_BOT_MEMORY_MAX_MB to a number of MB to enforce)"]);
    for (let look = 0; look < 30; look++) { h.advance(10_000); expect(await h.watchdog.check()).toEqual([]); }
    expect(h.signals).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.watchdog.stops()).toBe(0);
    expect(h.watchdog.flagged()).toBe(1);
    expect(h.watchdog.stopFor("tb", h.now())).toBeNull();
    expect(h.watchdog.stoppedEngine("tb", 300, h.now())).toBe(false);
    useBotMemoryWatchdog(h.watchdog);
    try { expect(stoppedForRoom("tb", 300)).toBe(false); } finally { useBotMemoryWatchdog(null); }
    // Back under, then over again past the window: a second event.
    sizes = { b: 500 };
    h.advance(20_000);
    await h.watchdog.check();
    sizes = { b: 1300 };
    h.advance(20_000);
    expect(await h.watchdog.check()).toEqual([]);
    h.advance(OVER_FOR_MS);
    expect((await h.watchdog.check()).map((noted) => noted.action)).toEqual(["logged"]);
    expect(h.watchdog.events().map((noted) => noted.usedMB)).toEqual([1700, 1400]);
    expect(h.signals).toEqual([]);
  });

  it("puts its events in the health report's perf part, trimmed with the bots", () => {
    const timings = createTurnTimings({ now: () => 1_800_000_000_000 });
    const event = { at: 1, botId: "bot_b", usedMB: 1700, measured: "pss", capMB: 1000, engines: 1, room: 0.1, freeMB: 300, pressure: true, action: "logged" };
    const cap = { mb: 1000, mode: "log" as const, rung: "watchdog", stops: 0, flagged: 5, events: Array.from({ length: 5 }, () => event) };
    const base = { hour: timings.window(), day: timings.day(), live: timings.live(), limits: null, process: null };
    const shown = perfHealth({ ...base, bots: { at: 1, bots: 0, shown: [], shared: { procs: 0, threads: 0, rssMB: 0, cpuS: 0, cpuPct: 0, engines: 0, browsers: 0 }, cap } });
    expect(shown.bots?.cap?.events).toHaveLength(5);
    const many = { at: 1, bots: 100, shared: { procs: 1, threads: 1, rssMB: 1, cpuS: 1, cpuPct: 1, engines: 1, browsers: 1 }, cap,
      shown: Array.from({ length: 200 }, (_, index) => ({ id: `bot_${"x".repeat(56)}${index}`, procs: 999, threads: 9999, rssMB: 99999, peakMB: 99999, cpuS: 99999.9, cpuPct: 100, engines: 9, browsers: 1 })) };
    const trimmed = perfHealth({ ...base, bots: many });
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(trimmed.bots?.shown).toHaveLength(3);
    expect(trimmed.bots?.cap?.events).toHaveLength(1);
  });
});

describe("an opt-in cap (a number of MB set)", () => {
  it("stops nothing while the server has room to spare, however far over the cap a bot is", async () => {
    const h = dog(() => processes({ b: 3000 }), { pressure: () => ROOMY });
    for (let look = 0; look < 10; look++) { await h.watchdog.check(); h.advance(OVER_FOR_MS); }
    expect(h.signals).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.watchdog.events().map((event) => [event.action, event.pressure])).toEqual([["held", false]]);
    // A room factor below 0.3 is pressure even before memory is short.
    const low = dog(() => processes({ b: 1600 }), { pressure: () => ({ room: 0.25, short: false, freeBytes: 4 * GB }) });
    await low.watchdog.check();
    low.advance(OVER_FOR_MS);
    expect((await low.watchdog.check()).map((event) => event.action)).toEqual(["engine"]);
  });

  it("gives a bot one engine's cap per engine it runs: two conversations are not one engine's budget", async () => {
    // Engines 300 and 310 at 700 MB each with a 100 MB browser: 1,500 MB against 2,000 MB.
    const two = dog(() => processes({ b: 700, b2: 700 }), { mode: "log", pressure: () => ROOMY });
    for (let look = 0; look < 5; look++) { expect(await two.watchdog.check()).toEqual([]); two.advance(OVER_FOR_MS); }
    // One engine of the same 1,500 MB: over.
    const one = dog(() => processes({ b: 1400 }), { mode: "log", pressure: () => ROOMY });
    await one.watchdog.check();
    one.advance(OVER_FOR_MS);
    expect((await one.watchdog.check()).map((event) => [event.botId, event.capMB, event.engines])).toEqual([["bot_b", 1000, 1]]);
  });

  it("stops in steps: what an exited engine left and the idle engines first, then (measured again) the largest busy engine, never another bot's or a shared one", async () => {
    // Bot B: busy engine 300 (1,600 MB), idle engine 310 (300 MB), an exited engine's leftover 321 (300 MB), browser 100 MB:
    // 2,300 MB against 2,000 MB. Bot A (1,200 MB) is over its own cap too but uses less. The shared engine is 5,000 MB.
    let sizes = { a: 1200, b: 1600, b2: 300, orphan: 300 };
    const h = dog(() => processes(sizes));
    expect(await h.watchdog.check()).toEqual([]);
    h.advance(10_000);
    // Memory short and over on a second look: the first step.
    expect((await h.watchdog.check()).map((event) => event.action)).toEqual(["idle"]);
    expect(h.signals).toEqual(["SIGTERM 310", "SIGTERM 311", "SIGTERM 321", "SIGKILL 310", "SIGKILL 311", "SIGKILL 321"]);
    expect(h.closed).toEqual([["tc", "td"]]);
    // Those gone, one engine of 1,600 MB and its browser: still over. The next step waits for a new measure.
    sizes = { a: 1200, b: 1600, b2: 0, orphan: 0 };
    h.signals.length = 0;
    expect(await h.watchdog.check()).toEqual([]);
    h.advance(5_000);
    expect((await h.watchdog.check()).map((event) => event.action)).toEqual(["engine"]);
    expect(h.signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 300", "SIGKILL 301"]);
    // Its browser goes with the conversation whose engine stopped, once that turn lets it go: never a step of its own.
    expect(h.closed).toEqual([["tc", "td"], ["tb"]]);
    expect(h.watchdog.stops()).toBe(2);
    expect(h.logs.at(-1)).toMatch(/^memory: bot bot_b uses 1700 MB \(proportional\), over the 1000 MB .*: stopping its largest busy engine$/);
  });

  it("acts on the bot using the most only, and stops an engine even when its browser is larger (the browser goes with it)", async () => {
    // Both far over with memory short: due at once. Bot B (2,000 MB) over bot A (1,500 MB): bot B only. Its browser
    // (1,400 MB) is larger than its busy engine, but a browser a running turn holds can't be closed: the engine goes,
    // and its conversation's browser with it.
    const h = dog(() => processes({ a: 1500, b: 600, browser: 1400 }));
    const [event, ...more] = await h.watchdog.check();
    expect(more).toEqual([]);
    expect(event).toMatchObject({ botId: "bot_b", action: "engine" });
    await h.watchdog.closed();
    expect(h.closed).toEqual([["tb"]]);
    expect(h.signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 300", "SIGKILL 301"]);
    // Its browser never closes (the turn still holds it): the next step is an engine again, never the browser.
    h.advance(10_000);
    await h.watchdog.check();
    expect((await h.watchdog.check()).map((step) => step.action)).toEqual(["engine"]);
    // Bot A, over too, is left alone while bot B uses more.
    expect(h.signals.some((line) => /\b20[01]$/.test(line))).toBe(false);
  });

  it("stops at once only far over with memory short, and with room factor alone waits the window", async () => {
    const far = dog(() => processes({ b: 1600 }), { busy: new Set(["tb"]) });
    expect((await far.watchdog.check()).map((event) => event.action)).toEqual(["engine"]);
    const near = dog(() => processes({ b: 1200 }), { pressure: () => ({ room: 0.2, short: false, freeBytes: 2 * GB }) });
    expect(await near.watchdog.check()).toEqual([]);
    near.advance(20_000);
    expect(await near.watchdog.check()).toEqual([]);
    near.advance(10_000);
    expect((await near.watchdog.check()).map((event) => event.action)).toEqual(["engine"]);
  });

  it("never stops an engine other conversations may join, even when it is the bot's largest, and says so when that is all", async () => {
    const owners = () => OWNERS.map((owner) => (owner.pid === 300 ? { ...owner, shareable: true } : owner));
    const h = dog(() => processes({ b: 1600, b2: 400 }), { owners, busy: new Set(["tb", "tc"]) });
    await h.watchdog.check();
    h.advance(OVER_FOR_MS);
    await h.watchdog.check();
    expect(h.signals).toEqual(["SIGTERM 310", "SIGTERM 311", "SIGKILL 310", "SIGKILL 311"]);
    const only = dog(() => processes({ b: 1600 }), { owners, busy: new Set(["tb"]) });
    expect((await only.watchdog.check()).map((event) => event.action)).toEqual(["nothing"]);
    for (let look = 0; look < 5; look++) { only.advance(OVER_FOR_MS); expect(await only.watchdog.check()).toEqual([]); }
    expect(only.signals).toEqual([]);
    expect(only.watchdog.stops()).toBe(0);
  });

  it("signals nothing whose start can't be read now, and kills only what is still the bot's after the grace", async () => {
    const unread = dog(() => processes({ b: 1600 }), { startOf: () => null });
    await unread.watchdog.check();
    expect(unread.signals).toEqual([]);
    const moved = dog(() => processes({ b: 1600 }), { startOf: (pid) => (pid === 301 ? "later" : `s${pid}`) });
    await moved.watchdog.check();
    expect(moved.signals).toEqual(["SIGTERM 300", "SIGKILL 300"]);
    // Read again after the grace: 301 is another process now (another start), so it gets no KILL.
    let rows = processes({ b: 1600 });
    const again = dog(() => rows);
    const checking = again.watchdog.check();
    rows = rows.map((row) => (row.pid === 301 ? { ...row, start: "other" } : row));
    await checking;
    expect(again.signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 300"]);
  });

  it("counts shared pages once, and a bot whose shares can't be read only when it is far over", async () => {
    const shared = dog(() => processes({ a: 1600 }), { pss: (pid) => (pid === 200 ? 700 * MB : pid === 201 ? 200 * MB : null), busy: new Set(["ta"]) });
    for (let look = 0; look < 3; look++) { expect(await shared.watchdog.check()).toEqual([]); shared.advance(OVER_FOR_MS); }
    let sizes = { a: 1300 };
    const unread = dog(() => processes(sizes), { pss: () => null, busy: new Set(["ta"]) });
    for (let look = 0; look < 3; look++) { expect(await unread.watchdog.check()).toEqual([]); unread.advance(OVER_FOR_MS); }
    sizes = { a: 1600 };
    await unread.watchdog.check();
    unread.advance(10_000);
    expect((await unread.watchdog.check()).map((event) => [event.botId, event.measured])).toEqual([["bot_a", "estimated"]]);
  });

  it("reads each process's proportional size again only every few looks", async () => {
    const h = dog(() => processes({ b: 1600 }), { mode: "log", pressure: () => ROOMY });
    await h.watchdog.check();
    const first = h.pssReads();
    h.advance(5_000);
    await h.watchdog.check();
    h.advance(5_000);
    await h.watchdog.check();
    expect(h.pssReads()).toBe(first);
    h.advance(10_000);
    await h.watchdog.check();
    expect(h.pssReads()).toBe(first * 2);
  });

  it("does not look while no engine runs, and its timer's body never rejects", async () => {
    let lists = 0;
    const idle = new BotMemoryWatchdog({ cap: () => ({ mode: "enforce", bytes: MB }), list: () => { lists += 1; return []; }, pressure: () => SHORT,
      owners: () => [{ pid: 500, botIds: ["bot_b"], kind: "browser" }, { pid: 320, botIds: ["bot_b"], kind: "engine", exited: true }] });
    expect(await idle.check()).toEqual([]);
    expect(lists).toBe(0);
    const logs: string[] = [];
    const broken = new BotMemoryWatchdog({ cap: () => ({ mode: "enforce", bytes: MB }), list: () => { throw new Error("no /proc"); }, owners: () => OWNERS, pressure: () => SHORT, log: (line) => logs.push(line) });
    await expect(broken.tick()).resolves.toBeUndefined();
    const throwing = new BotMemoryWatchdog({ cap: () => { throw new Error("bad cap"); }, list: () => [], owners: () => OWNERS, pressure: () => SHORT, log: (line) => logs.push(line) });
    await expect(throwing.tick()).resolves.toBeUndefined();
    expect(logs).toEqual(["memory: the per-bot check failed: no /proc", "memory: the per-bot check failed: bad cap"]);
  });
});

describe("the line a stopped turn ends with", () => {
  it("is shown on the turn whose engine was stopped, not another conversation of the same bot", async () => {
    // Bot B: busy engine 300 (tb, 3,000 MB) and 310 (tc, 200 MB, busy too), its browser 100 MB: 3,300 MB against 2,000 MB,
    // far over with memory short. The largest busy engine is 300.
    const h = dog(() => processes({ b: 3000, b2: 200 }), { busy: new Set(["tb", "tc"]) });
    const listeners = new Set<RuntimeEventListener>();
    const instance = withBotMemoryCap({
      instanceId: "i", driverKind: "claudeAgent", displayName: "x", enabled: true,
      adapter: { sendTurn: async () => ({ turnId: "t" }), onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    } as unknown as ProviderInstance, () => h.watchdog, (botId) => (botId === "bot_b" ? "Researcher" : botId), h.now);
    const seen: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => seen.push(event));
    const emit = (event: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ eventId: "e", provider: "claudeAgent", createdAt: "", ...event } as RuntimeEvent); };
    const shown = () => seen.map((event) => (event.type === "runtime.error" ? event.message : event.type));
    for (const [threadId, botId] of [["tb", "bot_b"], ["tc", "bot_b"], ["ta", "bot_a"]]) await instance.adapter.sendTurn({ threadId, botId, text: "go" } as SendTurnInput);
    h.advance(1_000);
    expect((await h.watchdog.check()).map((event) => event.action)).toEqual(["engine"]);
    expect(h.signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 300", "SIGKILL 301"]);
    emit({ threadId: "tb", turnId: "t", type: "runtime.error", message: "the process running this turn's AI ended" });
    emit({ threadId: "tb", turnId: "t", type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    emit({ threadId: "tc", turnId: "t", type: "runtime.error", message: "its own failure" });
    emit({ threadId: "ta", turnId: "t", type: "runtime.error", message: "something else" });
    const line = "Researcher used more memory than this computer allows for one bot (3300 MB of 2000 MB) while memory was running short, so I stopped this task to keep the other bots running. "
      + "Send the message again to start over; if it keeps happening, give this task less to do at once, or give this computer more memory.";
    expect(shown()).toEqual([line, "turn.completed", "its own failure", "something else"]);
    expect(seen[0]).toMatchObject({ text: { key: "chat.notice.botMemoryCap", params: { bot: "Researcher", used: "3300", cap: "2000" } } });
    // A fault a retry cannot fix: no automatic retry or Chief retry starts the bot into the same cap again.
    expect(hostFaultOf(line)).toBe("bot_memory");
    expect(retryCannotFix("bot_memory")).toBe(true);
    expect(retriesTeammateThread(line)).toBe(false);
    expect(namesOwnCause(line)).toBe(true);
    expect(memoryStopped(line)).toBe(false);
    // The driver does not resend the stopped engine's turn; the other conversation's engine was not stopped.
    useBotMemoryWatchdog(h.watchdog);
    try {
      expect(stoppedForRoom("tb", 300)).toBe(true);
      expect(stoppedForRoom("tc", 310)).toBe(false);
      expect(stoppedForRoom("tc", 300)).toBe(false);
    } finally { useBotMemoryWatchdog(null); }
    await settle();
    // A turn started after the stop fails for its own reasons.
    seen.length = 0;
    h.advance(1_000);
    await instance.adapter.sendTurn({ threadId: "tb", botId: "bot_b", text: "again" } as SendTurnInput);
    emit({ threadId: "tb", turnId: "t2", type: "runtime.error", message: "its own failure" });
    expect(shown()).toEqual(["its own failure"]);
  });
});
