import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { launchHealth, launchLines } from "./launch-report.ts";
import { createLaunchTimings, LAUNCH_DAYS_KEPT, LAUNCH_FILE, LAUNCH_MARKS, LAUNCH_RING_CAP, LAUNCH_SETTLE_MS, parseLaunchPart } from "./launch-timings.ts";
import { createPerfDiagnosticsRoutes, LAUNCH_PATH } from "../routes/perf-diagnostics.ts";
import { PASS } from "../routes/table.ts";

const START = 1_800_000_000_000;
const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "launch-timings-")); dirs.push(dir); return dir; };

const mainPart = (processStart = START, extra: Record<string, unknown> = {}) => ({
  from: "main", launchId: "launch-0001", processStart, appVersion: "0.1.170", platform: "darwin", arch: "arm64", hidden: false,
  marks: { codeStart: 100, mainImported: 150, ready: 180, splashMade: 250, splashShown: 330, keysRead: 290, leaseTaken: 370, serverForked: 430, serverSpawned: 450, serverListening: 750, serverReady: 770, windowMade: 850, windowNavigated: 855, windowShown: 990 },
  spans: { keychain: 12, lease: 25 },
  children: [{ name: "sysctl", ms: 3 }, { name: "ioreg", ms: 18 }, { name: "scutil", ms: 20 }, { name: "scutil", ms: 22 }],
  net: { accounts: { n: 1, ms: 120 } },
  ...extra,
});
const pagePart = (timeOrigin = START + 860, extra: Record<string, unknown> = {}) => ({
  from: "page", timeOrigin, marks: { pageResponse: 28, firstPaint: 170, sidebarDrawn: 335, chatDrawn: 340, lastLongTaskEnd: 520 }, net: { other: { n: 3, ms: 57 } }, ...extra,
});
const serverPart = () => ({ startedAt: START + 452, listeningAt: START + 748, children: [{ name: "ioreg", ms: 14 }, { name: "/Users/ada/bin/acme-tool", ms: 40 }], net: { updates: { n: 1, ms: 24 } } });

describe("a launch's record", () => {
  it("joins the main process's, the page's and the server's parts on the process's own clock", () => {
    let now = START + 3_000;
    const timings = createLaunchTimings({ now: () => now, uptimeS: () => 3_600, launchId: "launch-0001", server: serverPart, counts: () => ({ bots: 31, threads: 62 }) });
    expect(timings.note(mainPart())).toEqual({ ok: true, complete: false });
    expect(timings.recent()).toEqual([]);
    now += 500;
    expect(timings.note(pagePart())).toEqual({ ok: true, complete: true });
    const [launch] = timings.recent();
    expect(launch).toEqual({
      at: START, appVersion: "0.1.170", platform: "darwin", arch: "arm64", cold: null, hidden: false, bots: 31, threads: 62,
      ms: { codeStart: 100, mainImported: 150, ready: 180, splashMade: 250, splashShown: 330, keysRead: 290, leaseTaken: 370, serverForked: 430, serverSpawned: 450,
        serverStarted: 452, serverListening: 750, serverReady: 770, windowMade: 850, windowNavigated: 855, windowShown: 990,
        pageResponse: 888, firstPaint: 1030, sidebarDrawn: 1195, chatDrawn: 1200, lastLongTaskEnd: 1380 },
      spans: { keychain: 12, lease: 25, serverBoot: 296 },
      children: [{ name: "scutil", where: "main", n: 2, ms: 42 }, { name: "ioreg", where: "main", n: 1, ms: 18 }, { name: "sysctl", where: "main", n: 1, ms: 3 },
        { name: "other", where: "server", n: 1, ms: 40 }, { name: "ioreg", where: "server", n: 1, ms: 14 }],
      net: { accounts: { n: 1, ms: 120 }, other: { n: 3, ms: 57 }, updates: { n: 1, ms: 24 } },
      parts: ["main", "page", "server"],
    });
    expect(Object.keys(launch!.ms).every((mark) => (LAUNCH_MARKS as readonly string[]).includes(mark))).toBe(true);
    expect(timings.stats().phases).toMatchObject({ splashShown: { n: 1, max: 330 }, windowShown: { n: 1, max: 990 }, chatDrawn: { n: 1, max: 1200 }, forkToListening: { n: 1, max: 320 }, keychain: { n: 1, max: 12 } });
  });

  it("is the same whichever part arrives first, and a sender asking again is told it is written", () => {
    const first = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    first.note(pagePart());
    expect(first.recent()).toEqual([]);
    expect(first.note(mainPart()).complete).toBe(true);
    const second = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    second.note(mainPart());
    second.note(pagePart());
    expect(first.recent()).toEqual(second.recent());
    expect(second.note(mainPart())).toEqual({ ok: true, complete: true });
    expect(second.note(pagePart(START + 99_000))).toEqual({ ok: true, complete: true });
    expect(second.recent()).toHaveLength(1);
  });

  it("is written without a page when none reports in time, or at a clean exit, and at once for a hidden start", () => {
    vi.useFakeTimers();
    const late = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    late.note(mainPart());
    vi.advanceTimersByTime(LAUNCH_SETTLE_MS - 1);
    expect(late.recent()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(late.recent()[0]).toMatchObject({ parts: ["main"], ms: { windowShown: 990 } });
    expect(late.recent()[0]!.ms.chatDrawn).toBeUndefined();
    expect(late.note(pagePart())).toEqual({ ok: true, complete: true });

    const quit = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    quit.note(mainPart());
    quit.flush();
    expect(quit.recent()).toHaveLength(1);
    const nothing = createLaunchTimings({ now: () => START });
    nothing.note(pagePart());
    nothing.flush();
    expect(nothing.recent()).toEqual([]);

    const hidden = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    expect(hidden.note(mainPart(START, { hidden: true, marks: { ready: 180, serverReady: 700 } }))).toEqual({ ok: true, complete: true });
    expect(hidden.recent()[0]).toMatchObject({ hidden: true, parts: ["main"] });
  });

  it("leaves out a page that is not this launch's window: a reload, or a window opened later", () => {
    const timings = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    timings.note(pagePart(START + 60_000));
    timings.note(mainPart());
    expect(timings.recent()[0]).toMatchObject({ parts: ["main"] });
    expect(timings.recent()[0]!.ms.chatDrawn).toBeUndefined();
  });

  it("refuses a part under another launch's id, and anything that is not a part", () => {
    const timings = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    expect(timings.note(mainPart(START, { launchId: "launch-9999" }))).toEqual({ ok: false, complete: false });
    for (const junk of [null, "main", 7, [], { from: "server" }, { from: "main" }, { from: "page", timeOrigin: "now" }, { from: "main", launchId: "../../etc", processStart: START }]) {
      expect(timings.note(junk).ok).toBe(false);
    }
    expect(timings.recent()).toEqual([]);
  });
});

describe("the saved launches", () => {
  it("are one owner-only file, read back by the next server, and a restarted server does not record a launch twice", () => {
    const dir = folder();
    const file = join(dir, LAUNCH_FILE);
    const first = createLaunchTimings({ file, now: () => START + 5_000, uptimeS: () => 60, launchId: "launch-0001" });
    first.note(mainPart());
    first.note(pagePart());
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = createLaunchTimings({ file, now: () => START + 60_000, uptimeS: () => 120, launchId: "launch-0001" });
    expect(restarted.recent()).toEqual(first.recent());
    expect(restarted.note(mainPart())).toEqual({ ok: true, complete: true });
    expect(restarted.recent()).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).ring).toHaveLength(1);
  });

  it("call a launch cold only when the computer started after the launch before it", () => {
    const dir = folder();
    const file = join(dir, LAUNCH_FILE);
    const launch = (at: number, uptimeS: number, id: string) => {
      const timings = createLaunchTimings({ file, now: () => at + 2_000, uptimeS: () => uptimeS, launchId: id });
      timings.note(mainPart(at, { launchId: id }));
      timings.note(pagePart(at + 860));
      return timings.recent().at(-1)!.cold;
    };
    expect(launch(START, 600, "launch-0001")).toBeNull();
    expect(launch(START + 3_600_000, 4_200, "launch-0002")).toBe(false);
    expect(launch(START + 7_200_000, 30, "launch-0003")).toBe(true);
    expect(createLaunchTimings({ file, now: () => START + 7_300_000 }).stats()).toMatchObject({ launches: 3, cold: 1 });
  });

  it("keep the latest launches and the latest days only", () => {
    const dir = folder();
    const file = join(dir, LAUNCH_FILE);
    let last = createLaunchTimings({ file });
    for (let index = 0; index < LAUNCH_RING_CAP + 5; index++) {
      const at = START + index * DAY;
      last = createLaunchTimings({ file, now: () => at + 2_000, uptimeS: () => 10, launchId: "launch-0001" });
      last.note(mainPart(at));
      last.note(pagePart(at + 860));
    }
    expect(last.recent()).toHaveLength(LAUNCH_RING_CAP);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.days).toHaveLength(LAUNCH_DAYS_KEPT);
    expect(last.stats().launches).toBe(LAUNCH_DAYS_KEPT);
    expect(last.stats(7).launches).toBe(7);
  });

  it("read nothing from a file that is not theirs", () => {
    const dir = folder();
    const file = join(dir, LAUNCH_FILE);
    for (const body of ["", "not json", JSON.stringify({ v: 2, ring: [mainPart()] }), JSON.stringify({ v: 1, ring: "x", days: { day: 1 } })]) {
      writeFileSync(file, body);
      const timings = createLaunchTimings({ file });
      expect(timings.recent()).toEqual([]);
      expect(timings.stats().launches).toBe(0);
    }
  });
});

describe("the launch record in the reports", () => {
  it("is plain lines of numbers, and nothing at all where no launch was recorded", () => {
    const timings = createLaunchTimings({ now: () => START + 3_000, uptimeS: () => 3_600, launchId: "launch-0001", server: serverPart, counts: () => ({ bots: 31, threads: 62 }) });
    expect(launchLines({ stats: timings.stats(), recent: timings.recent() })).toEqual([]);
    expect(launchHealth({ stats: timings.stats(), recent: timings.recent() })).toBeNull();
    timings.note(mainPart());
    timings.note(pagePart());
    const lines = launchLines({ stats: timings.stats(), recent: timings.recent() });
    expect(lines.slice(0, 3)).toEqual([
      "App launches (times from process start): 1 in the last 30 days, 0 of them the first since the computer started",
      "  Latest 1: splash shown p50 330ms p90 330ms max 330ms; window shown p50 990ms p90 990ms max 990ms; chat drawn p50 1.20s p90 1.20s max 1.20s; "
        + "server fork to listening p50 320ms p90 320ms max 320ms; keychain read p50 12ms p90 12ms max 12ms",
      "  By day, last 30 days (counted in steps, so each reads up to a quarter high): splash shown p50 under 330ms p90 under 330ms max 330ms; "
        + "window shown p50 under 990ms p90 under 990ms max 990ms; chat drawn p50 under 1.20s p90 under 1.20s max 1.20s; "
        + "server fork to listening p50 under 320ms p90 under 320ms max 320ms; keychain read p50 under 12ms p90 under 12ms max 12ms",
    ]);
    expect(lines[3]).toContain("2027-01-15T08:00:00Z 0.1.170 darwin arm64 (main+page+server; 31 bots, 62 conversations): codeStart 100ms");
    expect(lines[3]).toContain("chatDrawn 1.20s");
    expect(lines[3]).toContain("inside: keychain 12ms, lease 25ms, serverBoot 296ms; programs started: scutil 2x 42ms, ioreg 18ms, sysctl 3ms, other (server) 40ms, ioreg (server) 14ms");
    expect(lines[3]).toContain("requests off this computer before the chat: accounts 1 in 120ms, updates 1 in 24ms, other 3 in 57ms");
    expect(launchHealth({ stats: timings.stats(), recent: timings.recent() })).toMatchObject({ launches: 1, cold: 0, recent: { chatDrawn: { p50: 1200, p90: 1200, max: 1200, n: 1 } }, last: { at: START, ms: { chatDrawn: 1200 } } });
  });
});

describe("POST /api/diagnostics/launch", () => {
  const call = async (launch: ((part: unknown) => { ok: boolean; complete: boolean } | null) | undefined, body: unknown, method = "POST") => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const route = createPerfDiagnosticsRoutes({ text: () => "", ...(launch ? { launch } : {}) });
    const out = await route({
      req: {} as never, res: { setHeader() {} } as never, url: new URL(`http://127.0.0.1${LAUNCH_PATH}`), path: LAUNCH_PATH, method, auth: {} as never,
      json: ((_res: unknown, status: number, payload: unknown) => { sent.push({ status, body: payload }); }) as never,
      readBody: (async () => { if (body instanceof Error) throw body; return body; }) as never,
    });
    return { out, sent };
  };

  it("hands the part to the recorder and answers whether the record is written", async () => {
    const timings = createLaunchTimings({ now: () => START, launchId: "launch-0001" });
    expect((await call(timings.note, mainPart())).sent).toEqual([{ status: 200, body: { ok: true, complete: false } }]);
    expect((await call(timings.note, pagePart())).sent).toEqual([{ status: 200, body: { ok: true, complete: true } }]);
  });

  it("is not there on a server no desktop app started, takes a broken body as no part, and leaves other methods alone", async () => {
    expect((await call(undefined, mainPart())).sent).toEqual([{ status: 404, body: { ok: false, complete: false } }]);
    expect((await call(() => null, mainPart())).sent[0]!.status).toBe(404);
    const timings = createLaunchTimings({ now: () => START });
    expect((await call(timings.note, new Error("too large"))).sent).toEqual([{ status: 200, body: { ok: false, complete: false } }]);
    expect((await call(timings.note, mainPart(), "GET")).out).toBe(PASS);
  });
});

describe("parseLaunchPart", () => {
  it("keeps numbers in range and names it knows; everything else is dropped or becomes other", () => {
    const part = parseLaunchPart(mainPart(START, {
      marks: { ready: 180, chatDrawn: 5, serverStarted: 9, splashShown: -1, windowShown: 1e12, keysRead: "290", __proto__: { polluted: 1 }, "/Users/ada": 4 },
      spans: { keychain: 12, serverBoot: 9, "ada@example.test": 3 },
      children: [{ name: "ioreg", ms: 5 }, { name: "IOREG", ms: 5 }, { name: "constructor", ms: 1 }, { name: "ioreg", ms: "9" }, "x", null],
      net: { accounts: { n: 2, ms: 9 }, "intranet.acme.test": { n: 1, ms: 1 }, cloud: { n: 0, ms: 5 }, other: { n: 1, ms: -4 } },
      appVersion: "0.1.170 /Users/ada", platform: "plan9", arch: "arm64; rm -rf",
    }));
    expect(part).toEqual({
      from: "main", launchId: "launch-0001", processStart: START, marks: { ready: 180 }, spans: { keychain: 12 },
      children: [{ name: "other", where: "main", n: 2, ms: 6 }, { name: "ioreg", where: "main", n: 1, ms: 5 }],
      net: { accounts: { n: 2, ms: 9 }, other: { n: 1, ms: 0 } }, appVersion: null, platform: null, arch: null, hidden: false,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
