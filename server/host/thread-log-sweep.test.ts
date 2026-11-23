import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBotActivity } from "../activity.ts";
import { readThreadEvents } from "../thread-events.ts";
import {
  AGE_MS, CUT_AFTER_MS, FIRST_PASS_MS, QUIET_MS, READ_FLOOR, STAMP_FILE, knownThreads, listLogs, parseBytes, schedulePasses, startThreadLogSweep, sweepLine,
  sweepThreadLogs, threadLogCap, threadLogCutEnabled, threadLogSweepMode, trimLog, type ThreadState,
} from "./thread-log-sweep.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const PAD = "x".repeat(400);

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "thread-log-sweep-"));
  mkdirSync(join(dataDir, "events"));
  mkdirSync(join(dataDir, "native"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const at = (i: number) => new Date(NOW - 60 * DAY + i * 1_000).toISOString();

/** A conversation's events log: tool runs, with session.started lines at `sessionsAt`. */
function writeEvents(threadId: string, count: number, sessionsAt: readonly number[] = []): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = { eventId: `e${i}`, provider: "claudeAgent", providerInstanceId: "claude", threadId, createdAt: at(i), turnId: `turn${Math.floor(i / 10)}` };
    if (sessionsAt.includes(i)) lines.push(JSON.stringify({ ...base, type: "session.started", sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, model: "m" }));
    else if (i % 2 === 0) lines.push(JSON.stringify({ ...base, type: "item.started", itemType: "tool", itemId: `i${i}`, title: "Bash", input: { command: `echo ${i} ${PAD}` } }));
    else lines.push(JSON.stringify({ ...base, type: "item.completed", itemType: "tool", itemId: `i${i - 1}`, ok: true }));
  }
  const file = join(dataDir, "events", `${threadId}.ndjson`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function writeNative(threadId: string, count: number): string {
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ at: at(i), dir: i % 2 ? "in" : "out", source: "claude", msg: { n: i, pad: PAD } }));
  const file = join(dataDir, "native", `${threadId}.ndjson`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const age = (file: string, ms: number) => utimesSync(file, new Date(NOW - ms), new Date(NOW - ms));
const threads = (entries: Record<string, boolean>) => () => new Map<string, ThreadState>(Object.entries(entries).map(([id, busy]) => [id, { busy }]));
const sessionIds = (file: string) => readFileSync(file, "utf8").split("\n").filter((line) => line.includes('"session.started"')).map((line) => JSON.parse(line).sessionId);
const BIG_CAP = 1024 ** 4;

describe("the conversation logs' switch and cap", () => {
  it("never cuts unless OMB_THREAD_LOG_CUT is set", async () => {
    expect(threadLogCutEnabled({})).toBe(false);
    expect(threadLogCutEnabled({ OMB_THREAD_LOG_CUT: "1" })).toBe(true);
    const small = writeEvents("small", 100);
    age(small, AGE_MS + DAY);
    const result = await sweepThreadLogs({ dataDir, mode: "on", cap: 1, threads: threads({ small: false }), now: () => NOW });
    expect(result.cut).toBe(0);
    expect(existsSync(small)).toBe(true);
  });

  it("schedules a pass soon after start, or when due by the last whole pass, and saves each whole one", async () => {
    vi.useFakeTimers();
    try {
      const stamp = join(dataDir, "cache", "stamp.json");
      let clock = NOW;
      const passes: number[] = [];
      schedulePasses(stamp, 6 * 60 * 60_000, async () => (passes.push(clock), true), () => clock);
      clock += FIRST_PASS_MS;
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS);
      expect(passes).toEqual([NOW + FIRST_PASS_MS]);
      expect(JSON.parse(readFileSync(stamp, "utf8")).at).toBe(NOW + FIRST_PASS_MS);
      vi.clearAllTimers();
      // A restart an hour later reads the stamp at its first timer and waits for the rest of the six hours.
      clock = NOW + FIRST_PASS_MS + 60 * 60_000;
      schedulePasses(stamp, 6 * 60 * 60_000, async () => (passes.push(clock), true), () => clock);
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS + 4 * 60 * 60_000);
      expect(passes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(passes).toHaveLength(2);
      vi.clearAllTimers();
      // A stamp from the future counts as none.
      writeFileSync(stamp, JSON.stringify({ at: clock + 10 * DAY }));
      schedulePasses(stamp, 6 * 60 * 60_000, async () => (passes.push(clock), true), () => clock);
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS);
      expect(passes).toHaveLength(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("a frozen home's pass reads nothing and writes no stamp", async () => {
    vi.useFakeTimers();
    try {
      const events = writeEvents("t1", 6_000);
      age(events, AGE_MS + DAY);
      let asked = 0;
      expect(startThreadLogSweep({ cloudHome: true, env: { OMB_THREAD_LOG_SWEEP: "on" }, dataDir, threads: () => (asked++, new Map()), paused: () => true, log: () => {} })).toBe(true);
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS);
      expect(asked).toBe(0);
      expect(existsSync(join(dataDir, STAMP_FILE))).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("is off unless set, and counts only in report", () => {
    expect(threadLogSweepMode({})).toBe("off");
    expect(threadLogSweepMode({ OMB_THREAD_LOG_SWEEP: "maybe" })).toBe("off");
    expect(threadLogSweepMode({ OMB_THREAD_LOG_SWEEP: "dry-run" })).toBe("report");
    expect(threadLogSweepMode({ OMB_THREAD_LOG_SWEEP: " ON " })).toBe("on");
  });

  it("caps at the larger of 2 GiB and 3% of the volume, or what the Admin set", () => {
    expect(threadLogCap({}, 10 * 1024 ** 3)).toBe(2 * 1024 ** 3);
    expect(threadLogCap({}, 200 * 1024 ** 3)).toBe(Math.floor(0.03 * 200 * 1024 ** 3));
    expect(threadLogCap({}, null)).toBe(2 * 1024 ** 3);
    expect(threadLogCap({ OMB_THREAD_LOG_CAP: "512M" }, 200 * 1024 ** 3)).toBe(512 * 1024 ** 2);
    expect(parseBytes("1.5G")).toBe(1.5 * 1024 ** 3);
    expect(parseBytes("12345")).toBe(12345);
    expect(parseBytes("-1")).toBeNull();
    expect(parseBytes("lots")).toBeNull();
  });

  it("knows every bot's and room's conversation, and which have a turn running", () => {
    const known = knownThreads(
      [{ id: "b1", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "side" }] }],
      [{ threadId: "room", tasks: [{ threadId: "room-task" }] }],
      (_bot, threadId) => threadId === "side",
    );
    expect(Object.fromEntries([...known].map(([id, state]) => [id, state.busy]))).toEqual({ main: false, side: true, room: false, "room-task": false });
  });
});

describe("sweepThreadLogs", () => {
  it("trims an idle month-old log to what the Inspector and Activity read, and keeps every session line", async () => {
    const events = writeEvents("t1", 6_000, [3, 2_500, 5_990]);
    const native = writeNative("t1", 6_000);
    age(events, AGE_MS + DAY);
    age(native, AGE_MS + DAY);
    const inspector = () => readThreadEvents({ eventsDir: join(dataDir, "events"), nativeDir: join(dataDir, "native"), threadId: "t1", limit: READ_FLOOR.lines });
    const activity = () => readBotActivity({ dataDir, eventsDir: join(dataDir, "events"), botId: "b1", threadIds: ["t1"], limit: 300 });
    const seen = { inspector: inspector().entries, activity: activity() };
    expect(seen.activity.length).toBeGreaterThan(0);
    const sizes = { events: statSync(events).size, native: statSync(native).size };

    const result = await sweepThreadLogs({ dataDir, mode: "on", cap: BIG_CAP, threads: threads({ t1: false }), now: () => NOW });

    expect(result.trimmed).toBe(2);
    expect(result.after).toBeLessThan(result.before);
    expect(statSync(events).size).toBeLessThan(sizes.events);
    expect(statSync(native).size).toBeLessThan(sizes.native);
    expect(inspector().entries).toEqual(seen.inspector);
    expect(activity()).toEqual(seen.activity);
    expect(sessionIds(events)).toEqual(["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000002500", "00000000-0000-4000-8000-000000005990"]);
    expect(statSync(events).mtimeMs).toBe(NOW - AGE_MS - DAY);
    if (process.platform !== "win32") expect(statSync(events).mode & 0o777).toBe(0o600);
    expect(existsSync(`${events}.sweep`)).toBe(false);
    expect(sweepLine(result)).toContain("2 trimmed");
  });

  it("leaves a busy, a recently written, an unknown and a small log alone", async () => {
    const busy = writeEvents("busy", 6_000);
    const recent = writeEvents("recent", 6_000);
    const unknown = writeEvents("orphan", 6_000);
    const small = writeEvents("small", 100);
    for (const file of [busy, unknown, small]) age(file, AGE_MS + DAY);
    age(recent, QUIET_MS - 60_000);
    const before = [busy, recent, unknown, small].map((file) => readFileSync(file, "utf8"));
    const result = await sweepThreadLogs({ dataDir, mode: "on", cap: 1, cut: true, threads: threads({ busy: true, recent: false, small: false }), now: () => NOW });
    expect([busy, recent, unknown].map((file) => readFileSync(file, "utf8"))).toEqual(before.slice(0, 3));
    // Over the cap, the small idle log is cut to its session lines (it has none) only once idle a week; it is.
    expect(existsSync(small)).toBe(false);
    expect(result.cut).toBe(1);
  });

  it("over the cap trims least recently written first, then cuts week-idle logs to their session lines", async () => {
    const old = writeEvents("old", 6_000, [10]);
    const older = writeNative("older", 6_000);
    const weekOld = writeEvents("week", 6_000, [20]);
    const fresh = writeEvents("fresh", 6_000, [30]);
    age(older, 20 * DAY);
    age(old, 10 * DAY);
    age(weekOld, CUT_AFTER_MS - DAY);
    age(fresh, QUIET_MS + 60_000);
    const listed = await listLogs(dataDir);
    const total = listed.reduce((sum, file) => sum + file.size, 0);
    const deps = { dataDir, cap: Math.floor(total * 0.1), cut: true, threads: threads({ old: false, older: false, week: false, fresh: false }), now: () => NOW };

    const report = await sweepThreadLogs({ ...deps, mode: "report" });
    expect(statSync(old).size).toBe(listed.find((file) => file.path === old)!.size);
    const result = await sweepThreadLogs({ ...deps, mode: "on" });
    expect(result.after).toBe(report.after);
    expect([result.trimmed, result.cut]).toEqual([4, 2]);
    expect(result.after).toBe((await listLogs(dataDir)).reduce((sum, file) => sum + file.size, 0));
    // A week idle: the 20-day native log is gone (it has no session lines), the 10-day events log keeps its session.
    expect(existsSync(older)).toBe(false);
    expect(sessionIds(old)).toEqual(["00000000-0000-4000-8000-000000000010"]);
    expect(readFileSync(old, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    // Under a week idle: trimmed to the panels' lines plus its session line, never cut.
    for (const [file, id] of [[weekOld, "20"], [fresh, "30"]] as const) {
      expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(READ_FLOOR.lines + 1);
      expect(sessionIds(file)).toEqual([`00000000-0000-4000-8000-0000000000${id}`]);
    }
  });

  it("a report counts and changes nothing", async () => {
    const events = writeEvents("t1", 6_000, [1]);
    const native = writeNative("t1", 6_000);
    age(events, AGE_MS + DAY);
    age(native, AGE_MS + DAY);
    const before = [events, native].map((file) => ({ text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, ino: statSync(file).ino }));
    const sessionLine = readFileSync(events, "utf8").split("\n").find((line) => line.includes('"session.started"'))!;
    const result = await sweepThreadLogs({ dataDir, mode: "report", cap: 1, cut: true, threads: threads({ t1: false }), now: () => NOW });
    expect([result.trimmed, result.cut]).toEqual([2, 2]);
    expect(result.after).toBe(sessionLine.length + 1);
    expect([events, native].map((file) => ({ text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, ino: statSync(file).ino }))).toEqual(before);
    expect(sweepLine(result)).toContain("would free");
  });

  it("changes nothing while a turn runs, and goes on once none does", async () => {
    const events = writeEvents("t1", 6_000);
    age(events, AGE_MS + DAY);
    const text = readFileSync(events, "utf8");
    const busy = await sweepThreadLogs({ dataDir, mode: "on", cap: BIG_CAP, threads: threads({ t1: false }), turnsRunning: () => true, turnWaitMs: 0, now: () => NOW });
    expect(busy.stopped).toBe(true);
    expect(readFileSync(events, "utf8")).toBe(text);
    let checks = 0;
    const later = await sweepThreadLogs({ dataDir, mode: "on", cap: BIG_CAP, threads: threads({ t1: false }), turnsRunning: () => checks++ < 1, turnWaitMs: 60_000, now: () => NOW });
    expect(later.trimmed).toBe(1);
  }, 30_000);

  it("stops before its next file when a move or backup starts", async () => {
    const events = writeEvents("t1", 6_000);
    age(events, AGE_MS + DAY);
    const text = readFileSync(events, "utf8");
    const result = await sweepThreadLogs({ dataDir, mode: "on", cap: 1, threads: threads({ t1: false }), paused: () => true, now: () => NOW });
    expect(result.stopped).toBe(true);
    expect(readFileSync(events, "utf8")).toBe(text);
  });
});

describe("what a sweep never reaches", () => {
  // Windows makes a link only with a privilege CI's runners lack; Cloud homes, where this runs, are Linux.
  it.skipIf(process.platform === "win32")("follows no link: a linked log, a linked folder, or a name that is not a conversation's", async () => {
    const outside = mkdtempSync(join(tmpdir(), "thread-log-outside-"));
    try {
      const target = join(outside, "victim.ndjson");
      writeFileSync(target, `${"y".repeat(2_000)}\n`.repeat(3_000));
      age(target, AGE_MS + DAY);
      symlinkSync(target, join(dataDir, "events", "linked.ndjson"));
      rmSync(join(dataDir, "native"), { recursive: true });
      symlinkSync(outside, join(dataDir, "native"));
      writeFileSync(join(dataDir, "events", "..%2Fescape.ndjson"), "x\n");
      expect((await listLogs(dataDir)).map((file) => file.path)).toEqual([]);
      await sweepThreadLogs({ dataDir, mode: "on", cap: 1, threads: threads({ linked: false, victim: false }), now: () => NOW });
      expect(statSync(target).size).toBe(2_001 * 3_000);
      expect(lstatSync(join(dataDir, "events", "linked.ndjson")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps a log that was written to while its trim was copied", async () => {
    const events = writeEvents("t1", 6_000, [1]);
    age(events, AGE_MS + DAY);
    const [listed] = await listLogs(dataDir);
    appendFileSync(events, `${JSON.stringify({ late: true })}\n`);
    expect(await trimLog(listed!, READ_FLOOR, true)).toBe(0);
    expect(readFileSync(events, "utf8")).toContain('"late":true');
    expect(readFileSync(events, "utf8").split("\n").filter(Boolean)).toHaveLength(6_001);
  });

  it("keeps every session line from the part it cuts away", async () => {
    const sessions = Array.from({ length: 1_500 }, (_, i) => i * 2 + 1);
    const events = writeEvents("t1", 6_000, sessions);
    age(events, AGE_MS + DAY);
    await sweepThreadLogs({ dataDir, mode: "on", cap: BIG_CAP, threads: threads({ t1: false }), now: () => NOW });
    expect(sessionIds(events)).toHaveLength(1_500);
  });

  it("keeps a log while the bus has its lines queued or an append under way", async () => {
    const events = writeEvents("t1", 6_000);
    age(events, AGE_MS + DAY);
    const text = readFileSync(events, "utf8");
    const result = await sweepThreadLogs({ dataDir, mode: "on", cap: BIG_CAP, threads: threads({ t1: false }), logQuiet: () => false, now: () => NOW });
    expect(result.trimmed).toBe(0);
    expect(readFileSync(events, "utf8")).toBe(text);
  });

  it("keeps a log when a turn starts while its trim was copied", async () => {
    const events = writeEvents("t1", 6_000, [1]);
    age(events, AGE_MS + DAY);
    const text = readFileSync(events, "utf8");
    const [listed] = await listLogs(dataDir);
    expect(await trimLog(listed!, READ_FLOOR, true, () => false)).toBe(0);
    expect(readFileSync(events, "utf8")).toBe(text);
    expect(existsSync(`${events}.sweep`)).toBe(false);
  });

  it("never trims a log whose newest line alone is past the floor's bytes", async () => {
    const file = join(dataDir, "events", "huge.ndjson");
    writeFileSync(file, `${"a".repeat(100)}\n${"b".repeat(READ_FLOOR.bytes + 10)}\n`);
    const [listed] = await listLogs(dataDir);
    expect(await trimLog(listed!, READ_FLOOR, true)).toBe(0);
    expect(statSync(file).size).toBe(101 + READ_FLOOR.bytes + 11);
  });
});
