import { describe, expect, it } from "vitest";

import { EFFECTS, type CursorState } from "./CursorAvatar";
import {
  FULL_FRAME_MS,
  GLYPH_EASE_MS,
  MOTION,
  SMOOTH_STEP_PX,
  frameIntervalFor,
  morphUnitsPerMs,
  nextFrameAt,
  nextMascotFrame,
  type CadenceInput,
} from "./mascot-motion";

const NOW = 10_000;

function delay(state: CursorState, sizePx: number, extra: Partial<CadenceInput> = {}): number {
  return nextMascotFrame(NOW, {
    motion: MOTION[state],
    effects: EFFECTS[state],
    stateElapsedMs: 60_000,
    strength: 1,
    showEffects: true,
    showGlyphs: true,
    sizePx,
    faceUnitsPerMs: 0,
    blinkingOrSpinning: false,
    ...extra,
  }) - NOW;
}

describe("mascot cadence", () => {
  it("picks the slowest frame tier that keeps each step smooth", () => {
    expect(frameIntervalFor(0)).toBe(Infinity);
    expect(frameIntervalFor(SMOOTH_STEP_PX / 50)).toBe(50);
    expect(frameIntervalFor(SMOOTH_STEP_PX / 40)).toBeCloseTo(1000 / 30);
    expect(frameIntervalFor(SMOOTH_STEP_PX / 20)).toBeCloseTo(FULL_FRAME_MS);
    expect(frameIntervalFor(1)).toBeCloseTo(FULL_FRAME_MS);
  });

  it("gives idle breathing no frames where it cannot be seen and a slow tier where it can", () => {
    expect(delay("idle", 24)).toBe(Infinity);
    expect(delay("idle", 64)).toBeGreaterThan(30);
    expect(delay("idle", 64)).toBeLessThanOrEqual(50);
    expect(delay("sleeping", 112)).toBeGreaterThan(30);
  });

  it("runs real motion at full rate", () => {
    expect(delay("working", 36)).toBeCloseTo(FULL_FRAME_MS);
    expect(delay("celebrate", 24)).toBeCloseTo(FULL_FRAME_MS);
    expect(delay("idle", 24, { blinkingOrSpinning: true })).toBeCloseTo(FULL_FRAME_MS);
    expect(delay("spawning", 64, { stateElapsedMs: 100 })).toBeCloseTo(FULL_FRAME_MS);
    expect(delay("spawning", 64, { stateElapsedMs: 5_000 })).toBeGreaterThan(30);
  });

  it("holds still with no motion strength", () => {
    expect(delay("working", 220, { strength: 0 })).toBe(Infinity);
    expect(delay("celebrate", 220, { strength: 0 })).toBe(Infinity);
  });

  it("puts every tier on one 60 Hz grid so mascots on different phases draw in the same frame", () => {
    expect(nextFrameAt(1003, 50)).toBe(nextFrameAt(1011, 50));
    expect(nextFrameAt(1003, 50) - 1003).toBeGreaterThanOrEqual(40);
    expect(nextFrameAt(1001, FULL_FRAME_MS)).toBe(nextFrameAt(1008, FULL_FRAME_MS));
    for (const interval of [50, 1000 / 30, FULL_FRAME_MS]) {
      const ticks = nextFrameAt(5_000, interval) / FULL_FRAME_MS;
      expect(Math.abs(ticks - Math.round(ticks))).toBeLessThan(1e-9);
    }
  });

  it("draws an alert glyph's fades at full rate and rests between them", () => {
    const glyph = EFFECTS.confused!.glyph!;
    const shown = glyph.period - glyph.hold;
    const at = (position: number) => delay("confused", 28, { stateElapsedMs: glyph.period * 3 + position });
    expect(at(shown - 400)).toBeGreaterThan(2 * FULL_FRAME_MS);
    expect(at(shown - 400)).toBeLessThanOrEqual(400);
    expect(at(shown + 10)).toBeCloseTo(FULL_FRAME_MS);
    expect(at(shown + GLYPH_EASE_MS + 100)).toBeGreaterThan(2 * FULL_FRAME_MS);
    expect(at(glyph.period - 10)).toBeCloseTo(FULL_FRAME_MS);
    expect(delay("confused", 28, { stateElapsedMs: glyph.period * 3 + shown + 10, showGlyphs: false })).toBeGreaterThan(2 * FULL_FRAME_MS);
  });

  it("follows an expression change until it settles", () => {
    expect(morphUnitsPerMs(0, 1, 7, 40)).toBe(0);
    const start = morphUnitsPerMs(0, 0, 7, 40);
    expect(start).toBeGreaterThan(0);
    expect(delay("idle", 24, { faceUnitsPerMs: start })).toBeLessThan(Infinity);
    expect(morphUnitsPerMs(0, 0.99, 7, 40)).toBeLessThan(start / 50);
  });
});
