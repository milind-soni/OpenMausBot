import { describe, expect, it } from "vitest";

import { carvedFrameMs, MOVING_FRAME_MS, nextCarvedFrameAt, poseAtRest, REST_EPSILON } from "./carved-rest";

const at = { gx: 0, gy: 0, wide: 0, shut: 0, smile: 1 };

describe("a carved face between frames", () => {
  it("reads a pose that has arrived as at rest", () => {
    expect(poseAtRest(at, { ...at })).toBe(true);
    expect(poseAtRest({ ...at, smile: 1 + REST_EPSILON / 2 }, at)).toBe(true);
  });

  it("does not call a face at rest while it still has somewhere to look", () => {
    expect(poseAtRest({ ...at, gx: 0.3 }, at)).toBe(false);
    expect(poseAtRest({ ...at, shut: 0.5 }, at)).toBe(false);
    expect(poseAtRest({ ...at, wide: 1 }, at)).toBe(false);
  });

  it("asks for frames at its own rate while it moves", () => {
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 50, moving: true, glanceAt: 5_000, blinkAt: 9_000 })).toBe(1_050);
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 16, moving: true, glanceAt: Infinity, blinkAt: Infinity })).toBe(1_016);
  });

  it("sleeps until the next glance or blink once it is still", () => {
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 50, moving: false, glanceAt: 2_400, blinkAt: 3_000 })).toBe(2_400);
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 50, moving: false, glanceAt: 4_000, blinkAt: 2_700 })).toBe(2_700);
  });

  it("asks for nothing at all when its mood neither glances nor blinks", () => {
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 50, moving: false, glanceAt: Infinity, blinkAt: Infinity })).toBe(Infinity);
  });

  it("never asks for a frame in the past", () => {
    expect(nextCarvedFrameAt({ now: 5_000, frameMs: 50, moving: false, glanceAt: 1_000, blinkAt: 9_000 })).toBe(5_001);
  });

  it("waits for the very next glance, however soon it is", () => {
    expect(nextCarvedFrameAt({ now: 1_000, frameMs: 50, moving: false, glanceAt: 1_120, blinkAt: 9_000 })).toBe(1_120);
  });

  it("keeps a moving face at forty frames a second or slower", () => {
    expect(carvedFrameMs(44)).toBeGreaterThanOrEqual(MOVING_FRAME_MS);
    expect(carvedFrameMs(240)).toBeGreaterThanOrEqual(MOVING_FRAME_MS);
    expect(1_000 / carvedFrameMs(240)).toBeLessThanOrEqual(40);
  });
});
