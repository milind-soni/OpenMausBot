import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageDailyCap, IMAGE_DAY_FILE } from "./image-daily-cap.ts";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "omb-image-cap-persistence-"));
  roots.push(root);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return join(root, "data");
};
const now = () => new Date(2026, 10, 5, 12);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("image limits when the count cannot be saved", () => {
  it("still caps successful images while the data directory is unavailable", () => {
    const cap = createImageDailyCap(fixture(), { cap: 2, now });
    for (let made = 0; made < 2; made += 1) {
      expect(cap.reserve()).toBe(true);
      cap.settle(true);
    }
    expect(cap.reserve()).toBe(false);
  });

  it("persists earlier unsaved images when writing succeeds again", () => {
    const dir = fixture();
    const cap = createImageDailyCap(dir, { cap: 3, now });
    expect(cap.reserve()).toBe(true);
    cap.settle(true);
    mkdirSync(dir);
    expect(cap.reserve()).toBe(true);
    cap.settle(true);
    expect(JSON.parse(readFileSync(join(dir, IMAGE_DAY_FILE), "utf8")))
      .toEqual({ day: "2026-11-05", count: 2 });
  });

  it("does not forget images already counted when the saved file disappears", () => {
    const dir = fixture();
    mkdirSync(dir);
    const cap = createImageDailyCap(dir, { cap: 2, now });
    cap.reserve();
    cap.settle(true);
    rmSync(join(dir, IMAGE_DAY_FILE));
    expect(cap.reserve()).toBe(true);
    cap.settle(true);
    expect(cap.reserve()).toBe(false);
  });

  it("resets unsaved counts at local midnight", () => {
    let day = 5;
    const cap = createImageDailyCap(fixture(), { cap: 1, now: () => new Date(2026, 10, day, 12) });
    cap.reserve();
    cap.settle(true);
    expect(cap.reserve()).toBe(false);
    day = 6;
    expect(cap.reserve()).toBe(true);
  });

  it("still observes a larger saved count from the same day", () => {
    const dir = fixture();
    mkdirSync(dir);
    const cap = createImageDailyCap(dir, { cap: 3, now });
    cap.reserve();
    cap.settle(true);
    writeFileSync(join(dir, IMAGE_DAY_FILE), JSON.stringify({ day: "2026-11-05", count: 3 }));
    expect(cap.reserve()).toBe(false);
  });
});
