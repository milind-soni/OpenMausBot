import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { createPerfDiagnosticsRoutes, STORAGE_MEASURE_PATH, STORAGE_PATH } from "../routes/perf-diagnostics.ts";
import type { RouteContext } from "../routes/table.ts";
import type { StorageReport } from "./disk-usage.ts";
import { cloudStorage, createPerfHost } from "./perf-host.ts";
import { createStorageMeasure, MEASURE_GAP_MS, readVolumeNow } from "./storage-measure.ts";

const START = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sampler() {
  let clock = START, running = false, lastPassAt: number | null = START - 3_600_000;
  const calls = { passNow: 0, tick: 0 };
  const measure = createStorageMeasure({
    passNow: () => { calls.passNow += 1; }, tick: async () => { calls.tick += 1; running = true; },
    running: () => running, lastPassAt: () => lastPassAt, now: () => clock,
  });
  return {
    measure, calls,
    advance: (ms: number) => { clock += ms; },
    finish: () => { running = false; lastPassAt = clock; },
    setLast: (at: number | null) => { lastPassAt = at; },
  };
}

describe("Measure again", () => {
  it("starts a pass at once, by asking for one and running the sampler's tick so a sleeping schedule wakes", () => {
    const s = sampler();
    expect(s.measure.inS()).toBe(0);
    expect(s.measure.measure()).toEqual({ started: true, running: true, inS: MEASURE_GAP_MS / 1000 });
    expect(s.calls).toEqual({ passNow: 1, tick: 1 });
  });

  it("never while a pass runs, and not again within the gap of the last pass's end or the last start asked for", () => {
    const s = sampler();
    s.measure.measure();
    expect(s.measure.measure()).toMatchObject({ started: false, running: true });
    s.advance(60_000);
    s.finish();
    expect(s.measure.measure()).toEqual({ started: false, running: false, inS: MEASURE_GAP_MS / 1000 });
    s.advance(MEASURE_GAP_MS - 1_000);
    expect(s.measure.inS()).toBe(1);
    s.advance(1_000);
    expect(s.measure.measure().started).toBe(true);
    expect(s.calls.passNow).toBe(2);
  });

  it("counts from the last start asked for when the pass it asked for has not ended yet", () => {
    const s = sampler();
    s.setLast(null);
    s.measure.measure();
    s.finish();
    s.setLast(null);
    s.advance(MEASURE_GAP_MS / 2);
    expect(s.measure.inS()).toBe(MEASURE_GAP_MS / 2000);
  });
});

describe("the volume now", () => {
  it("reads used and free as the report does, and null when the filesystem can't be read", async () => {
    expect(await readVolumeNow("/data", async () => ({ blocks: 1_000, bsize: 4096, bavail: 300, bfree: 350 })))
      .toEqual({ totalBytes: 4_096_000, freeBytes: 1_228_800, usedBytes: 2_662_400 });
    expect(await readVolumeNow("/data", async () => { throw new Error("EIO"); })).toBeNull();
  });
});

describe("the storage routes", () => {
  const report = { v: 1, at: START, running: false } as unknown as StorageReport;
  async function call(method: "GET" | "POST", path: string, deps: Parameters<typeof createPerfDiagnosticsRoutes>[0]) {
    let answered: { status: number; body: unknown } | null = null;
    await createPerfDiagnosticsRoutes(deps)({
      req: {} as RouteContext["req"], res: { setHeader: () => undefined } as unknown as RouteContext["res"], url: new URL(`http://x${path}`), path, method,
      auth: {} as RouteContext["auth"], json: ((_res: unknown, status: number, body: unknown) => { answered = { status, body }; }) as unknown as RouteContext["json"],
      readBody: (async () => null) as unknown as RouteContext["readBody"],
    });
    return answered as { status: number; body: unknown } | null;
  }
  const volume = { totalBytes: 100, freeBytes: 10, usedBytes: 90 };

  it("GET carries the volume now and when a pass may be asked for beside the report, only where there is a report", async () => {
    const deps = { text: () => "", storage: () => report, storageNow: async () => volume, storageMeasureInS: () => 0 };
    expect(await call("GET", STORAGE_PATH, deps)).toEqual({ status: 200, body: { storage: report, now: volume, measureInS: 0 } });
    expect(await call("GET", STORAGE_PATH, { ...deps, storage: () => null })).toEqual({ status: 200, body: { storage: null } });
    expect(await call("GET", STORAGE_PATH, { ...deps, storageNow: async () => { throw new Error("EIO"); } })).toEqual({ status: 200, body: { storage: report, now: null, measureInS: 0 } });
    expect(await call("GET", STORAGE_PATH, { ...deps, serverId: "env-a" })).toEqual({ status: 200, body: { storage: report, now: volume, measureInS: 0, server: "env-a" } });
  });

  it("POST asks for a pass, and is 404 where nothing is measured", async () => {
    const answer = { started: true, running: true, inS: 600 };
    expect(await call("POST", STORAGE_MEASURE_PATH, { text: () => "", measureStorage: () => answer })).toEqual({ status: 200, body: answer });
    expect((await call("POST", STORAGE_MEASURE_PATH, { text: () => "" }))?.status).toBe(404);
  });

  it("is admin scope: a Team Cloud member's session and a service caller never reach either", () => {
    expect(requiredScope("POST", STORAGE_MEASURE_PATH)).toBe("admin");
    expect(serviceAllowed("POST", STORAGE_MEASURE_PATH)).toBe(false);
    expect(requiredScope("GET", STORAGE_PATH)).toBe("admin");
  });
});

describe("on a Cloud home's perf host", () => {
  it("Measure again runs a pass now, and the report keeps a deleted bot's leftovers apart from the bots it lists", async () => {
    const home = mkdtempSync(join(tmpdir(), "storage-measure-"));
    dirs.push(home);
    const data = join(home, ".openmausbot");
    const write = (path: string, bytes: number) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 7)); };
    write(join(data, "workspaces", "bot-known", "notes.md"), 8_000);
    write(join(data, "workspaces", "bot-gone", "old.txt"), 3_000);
    const host = createPerfHost({ dataDir: data, timer: false, wholeMachine: true, bus: { subscribe: () => () => {} }, store: { onChange: () => () => {}, botByThread: () => null },
      now: () => START, ...cloudStorage({}, home, (id) => id === "bot-known") });
    expect(host.storage()).toMatchObject({ at: null, running: false });
    expect(host.storageMeasureInS()).toBe(0);
    expect(host.measureStorage()).toMatchObject({ started: true });
    for (let index = 0; index < 2_000 && host.storage()?.at === null; index++) await new Promise((resolve) => setTimeout(resolve, 10));
    const report = host.storage()!;
    expect(report.at).toBe(START);
    expect(report.bots.map((bot) => bot.id)).toEqual(["bot-known"]);
    expect(report.botsGone).toMatchObject({ count: 1, files: 1 });
    expect(report.botsGone!.bytes).toBeGreaterThanOrEqual(3_000);
    expect(host.measureStorage()).toMatchObject({ started: false, inS: MEASURE_GAP_MS / 1000 });
    expect(await host.storageNow()).toMatchObject({ totalBytes: expect.any(Number), freeBytes: expect.any(Number) });
    host.stop();
  });
});
