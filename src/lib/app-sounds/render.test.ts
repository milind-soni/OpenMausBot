import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOUND_STYLE, phraseOf, renderSound, SOUND_EVENTS, SOUND_PEAK, SOUND_STYLES, stepFrequency, type SoundCue } from "./render";

const RATES = [44_100, 48_000];
const CUES: SoundCue[] = [...SOUND_EVENTS, "preview"];
const cases = CUES.flatMap((cue) => SOUND_STYLES.map((style) => [cue, style] as const));
const NEW_STYLES = ["tap", "breeze"] as const;
const dB = (ratio: number) => 20 * Math.log10(ratio);

function peakOf(samples: Float32Array, from = 0, to = samples.length) {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/** Loudness as heard: the root mean square over the loudest 50 ms, a sound shorter than that counted as silent for the rest. */
function loudnessOf(samples: Float32Array, rate = 48_000) {
  const span = Math.round(0.05 * rate);
  let loudest = 0;
  for (let start = 0; start < samples.length; start += Math.round(rate / 200)) {
    let energy = 0;
    for (let i = start; i < Math.min(samples.length, start + span); i++) energy += samples[i] * samples[i];
    loudest = Math.max(loudest, Math.sqrt(energy / span));
  }
  return loudest;
}

describe("app sounds rendered offline", () => {
  it.each(cases)("%s in %s is finite, short, quiet and silent at both ends", (cue, style) => {
    for (const rate of RATES) {
      const samples = renderSound(cue, style, rate);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples.length / rate).toBeLessThanOrEqual(phraseOf(cue, style).limit);
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
    const sends = SOUND_STYLES.map((style) => renderSound("send", style, 48_000));
    for (const [index, one] of sends.entries()) for (const other of sends.slice(index + 1)) expect(one).not.toEqual(other);
  });

  it.each([
    ["click", "7f46573f537ddaf7104c3644a771227fc72f797c748cbdb62966beb8ab3e88c8"],
    ["glass", "8b27ddaac3680cdbdd9acd4e43eff78e69b36bc4698e6aeed8e95b6cdb1ac8b7"],
    ["retro", "49fc8871cf706c8b9019aadb037ca6fee9a4638ae3b5df611e50c113375d19c0"],
  ] as const)("keeps every %s sample as it was", (style, digest) => {
    const hash = createHash("sha256");
    for (const rate of RATES) for (const event of SOUND_EVENTS) hash.update(new Uint8Array(renderSound(event, style, rate).buffer));
    expect(hash.digest("hex")).toBe(digest);
    expect(renderSound("preview", style, 48_000)).toEqual(renderSound("done", style, 48_000));
  });

  it.each(NEW_STYLES)("orders %s from send, the quietest, through stop and reply to the preview", (style) => {
    const [send, stop, reply, preview] = (["send", "stop", "reply", "preview"] as const).map((cue) => peakOf(renderSound(cue, style, 48_000)));
    expect(send).toBeLessThan(stop);
    expect(stop).toBeLessThan(reply);
    expect(reply).toBeLessThan(preview);
    expect(renderSound("done", style, 48_000)).toEqual(renderSound("reply", style, 48_000));
    expect(renderSound("stop", style, 48_000).length / 48_000).toBeLessThan(0.04);
  });

  it.each(NEW_STYLES)("keeps the %s send quieter than the stop by loudness over 50 ms, not only by peak", (style) => {
    const [send, stop, reply, preview] = (["send", "stop", "reply", "preview"] as const).map((cue) => loudnessOf(renderSound(cue, style, 48_000)));
    expect(dB(stop / send)).toBeGreaterThanOrEqual(1);
    expect(stop).toBeLessThan(reply);
    expect(reply).toBeLessThan(preview);
  });

  it("makes the tap send one dry strike, well under the preview", () => {
    const send = renderSound("send", "tap", 48_000);
    expect(send.length / 48_000).toBeLessThan(0.03);
    expect(dB(peakOf(renderSound("preview", "tap", 48_000)) / peakOf(send))).toBeGreaterThanOrEqual(4);
    expect(peakOf(send)).toBeLessThan(peakOf(renderSound("send", "click", 48_000)));
  });

  it("draws every note from one pentatonic scale, an octave per five steps", () => {
    expect(stepFrequency(5) / stepFrequency(0)).toBeCloseTo(2, 10);
    expect(stepFrequency(-5) / stepFrequency(0)).toBeCloseTo(0.5, 10);
    const semitones = [0, 1, 2, 3, 4].map((step) => Math.round(12 * Math.log2(stepFrequency(step) / stepFrequency(0))));
    expect(semitones).toEqual([0, 2, 4, 7, 9]);
  });
});

describe("sound style order", () => {
  it("lists Tap first and plays it for anyone who never picked a style", () => {
    expect(SOUND_STYLES).toEqual(["tap", "click", "glass", "retro", "breeze"]);
    expect(DEFAULT_SOUND_STYLE).toBe(SOUND_STYLES[0]);
  });
});
