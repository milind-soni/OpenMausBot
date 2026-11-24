import { describe, expect, it } from "vitest";
import { PHRASES, renderSound, SOUND_EVENTS, SOUND_PEAK, SOUND_STYLES, stepFrequency } from "./render";

const RATES = [44_100, 48_000];
const cases = SOUND_EVENTS.flatMap((event) => SOUND_STYLES.map((style) => [event, style] as const));

function peakOf(samples: Float32Array, from = 0, to = samples.length) {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

describe("app sounds rendered offline", () => {
  it.each(cases)("%s in %s is finite, short, quiet and silent at both ends", (event, style) => {
    for (const rate of RATES) {
      const samples = renderSound(event, style, rate);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples.length / rate).toBeLessThanOrEqual(PHRASES[event].limit);
      const peak = peakOf(samples);
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(SOUND_PEAK + 1e-6);
      expect(Math.abs(samples[0])).toBe(0);
      expect(Math.abs(samples.at(-1)!)).toBe(0);
      const edge = Math.round(rate / 2000);
      expect(peakOf(samples, 0, edge)).toBeLessThan(0.01);
      expect(peakOf(samples, samples.length - edge)).toBeLessThan(0.01);
    }
  });

  it("keeps the recording cue under a tenth of a second and the discard quieter than the rest", () => {
    for (const style of SOUND_STYLES) {
      expect(renderSound("record", style, 48_000).length / 48_000).toBeLessThan(0.1);
      const discard = peakOf(renderSound("discard", style, 48_000));
      for (const event of SOUND_EVENTS) if (event !== "discard") expect(discard).toBeLessThan(peakOf(renderSound(event, style, 48_000)));
    }
  });

  it("renders the same samples every time", () => {
    expect(renderSound("done", "glass", 48_000)).toEqual(renderSound("done", "glass", 48_000));
  });

  it("gives each style its own sound", () => {
    const [click, glass, retro] = SOUND_STYLES.map((style) => renderSound("send", style, 48_000));
    expect(click).not.toEqual(glass);
    expect(glass).not.toEqual(retro);
  });

  it("draws every note from one pentatonic scale, an octave per five steps", () => {
    expect(stepFrequency(5) / stepFrequency(0)).toBeCloseTo(2, 10);
    expect(stepFrequency(-5) / stepFrequency(0)).toBeCloseTo(0.5, 10);
    const semitones = [0, 1, 2, 3, 4].map((step) => Math.round(12 * Math.log2(stepFrequency(step) / stepFrequency(0))));
    expect(semitones).toEqual([0, 2, 4, 7, 9]);
  });
});
