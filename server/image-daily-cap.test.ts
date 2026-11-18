import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createImageDailyCap, IMAGE_DAILY_CAP, IMAGE_DAY_FILE } from "./image-daily-cap.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "omb-image-cap-"));
const at = (day: number, hour = 12) => () => new Date(2026, 10, day, hour, 0, 0);

it("allows 50 images a day by default", () => {
  const cap = createImageDailyCap(scratch(), { now: at(5) });
  expect(cap.cap).toBe(IMAGE_DAILY_CAP);
  expect(IMAGE_DAILY_CAP).toBe(50);
  for (let made = 0; made < 50; made += 1) {
    expect(cap.reserve()).toBe(true);
    cap.settle(true);
  }
  expect(cap.reserve()).toBe(false);
});

it("counts images being made, and frees the place of one the provider did not make", () => {
  const cap = createImageDailyCap(scratch(), { cap: 2, now: at(5) });
  expect([cap.reserve(), cap.reserve(), cap.reserve()]).toEqual([true, true, false]);
  cap.settle(false);
  expect(cap.reserve()).toBe(true);
});

it("keeps the day's count on disk, so a restart does not reset it", () => {
  const dir = scratch();
  const before = createImageDailyCap(dir, { cap: 2, now: at(5, 9) });
  for (let made = 0; made < 2; made += 1) { before.reserve(); before.settle(true); }
  expect(JSON.parse(readFileSync(join(dir, IMAGE_DAY_FILE), "utf8"))).toEqual({ day: "2026-11-05", count: 2 });
  expect(createImageDailyCap(dir, { cap: 2, now: at(5, 23) }).reserve()).toBe(false);
});

it("starts again at local midnight", () => {
  const dir = scratch();
  let now = at(5, 23);
  const cap = createImageDailyCap(dir, { cap: 1, now: () => now() });
  cap.reserve();
  cap.settle(true);
  expect(cap.reserve()).toBe(false);
  now = at(6, 0);
  expect(cap.reserve()).toBe(true);
});

it("reads a damaged count file as no images yet", () => {
  const dir = scratch();
  writeFileSync(join(dir, IMAGE_DAY_FILE), "{not json");
  expect(createImageDailyCap(dir, { cap: 1, now: at(5) }).reserve()).toBe(true);
});
