// Rotation for the per-thread NDJSON tees: a cap must keep whole lines and
// the recent tail the inspector serves (including mid-turn, when appends
// continue right after a rotation), leave exactly one file so the delete
// and retention paths cannot orphan a fragment, and do nothing at all
// unless a cap is configured.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { appendNative } from "./drivers/native.ts";
import { EventBus } from "./harness/bus.ts";
import { bindThreadLogCapProvider, capThreadLog, currentThreadLogCap } from "./thread-log-rotation.ts";
import { readThreadEvents } from "./thread-events.ts";

const THREAD = "t-rotate";
const stamp = (i: number) => `2026-01-01T00:00:${String(i).padStart(4, "0")}.000Z`;
const log = (i: number) =>
  JSON.stringify({ eventId: `ev-${i}`, provider: "fake", threadId: THREAD, createdAt: stamp(i), type: "turn.started" }) + "\n";
const busEvent = (i: number): RuntimeEvent =>
  ({
    eventId: `ev-${i}`,
    provider: "fake",
    threadId: THREAD,
    createdAt: stamp(i),
    type: "turn.started",
  }) as RuntimeEvent;

function writeLines(dir: string, count: number) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${THREAD}.ndjson`), Array.from({ length: count }, (_, i) => log(i)).join(""));
}

function linesOf(dir: string): string[] {
  return readFileSync(join(dir, `${THREAD}.ndjson`), "utf8").split("\n").filter(Boolean);
}

describe("thread log rotation", () => {
  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    rmSync(NATIVE_DIR, { recursive: true, force: true });
    ensureDirs();
  });
  afterEach(() => bindThreadLogCapProvider(() => null));

  it("is off until a cap is configured", () => {
    writeLines(EVENTS_DIR, 50);
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    const before = readFileSync(file, "utf8");
    expect(currentThreadLogCap()).toBeNull();
    capThreadLog(file, null);
    capThreadLog(join(EVENTS_DIR, "missing.ndjson"), 100);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("leaves a log at or under the cap untouched", () => {
    writeLines(EVENTS_DIR, 3);
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    const before = readFileSync(file, "utf8");
    capThreadLog(file, before.length);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("trims an over-cap log to the newest half on line boundaries", () => {
    writeLines(EVENTS_DIR, 80);
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    const original = linesOf(EVENTS_DIR);
    capThreadLog(file, 2000);
    const kept = linesOf(EVENTS_DIR);
    expect(statSync(file).size).toBeLessThanOrEqual(2000);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(original.length);
    // a strict suffix of the original stream: whole records, newest kept
    expect(original.slice(-kept.length)).toEqual(kept);
  });

  it("keeps the inspector tail working across a mid-turn rotation", () => {
    writeLines(EVENTS_DIR, 120);
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    capThreadLog(file, 2000);
    // the turn keeps going after the rotation: new appends land in the
    // rewritten file and the tail read stays continuous
    appendFileSync(file, log(1000) + log(1001));
    const linesNow = linesOf(EVENTS_DIR);
    const page = readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId: THREAD, limit: 5 });
    expect(page.total.runtime).toBe(linesNow.length);
    const ids = page.entries.map((entry) => (entry.kind === "runtime" ? entry.data.eventId : ""));
    expect(ids.slice(-2)).toEqual(["ev-1000", "ev-1001"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves one file, so delete and retention cleanup cannot orphan a fragment", () => {
    writeLines(EVENTS_DIR, 40);
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    capThreadLog(file, 500);
    expect(readdirSync(EVENTS_DIR)).toEqual([`${THREAD}.ndjson`]);
    // the exact unlink thread, bot and group delete (and the retention
    // sweep) already perform removes everything rotation ever wrote
    unlinkSync(file);
    expect(readdirSync(EVENTS_DIR)).toEqual([]);
  });

  it("the bus caps its canonical log after appending", () => {
    bindThreadLogCapProvider(() => 900);
    const bus = new EventBus();
    for (let i = 0; i < 30; i++) bus.publish(busEvent(i));
    const file = join(EVENTS_DIR, `${THREAD}.ndjson`);
    const lines = linesOf(EVENTS_DIR);
    expect(statSync(file).size).toBeLessThanOrEqual(900);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(30);
    expect(lines.at(-1)).toContain('"ev-29"');
    expect(readFileSync(file, "utf8")).not.toContain('"eventId":"ev-0"');
  });

  it("the native tee caps its log after appending", () => {
    bindThreadLogCapProvider(() => 400);
    for (let i = 0; i < 12; i++) appendNative(THREAD, { dir: "in", source: "test", msg: { i } });
    const file = join(NATIVE_DIR, `${THREAD}.ndjson`);
    const lines = linesOf(NATIVE_DIR);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(12);
    expect(lines.at(-1)).toContain('"i":11');
    expect(readFileSync(file, "utf8")).not.toContain('"i":0,');
  });
});
