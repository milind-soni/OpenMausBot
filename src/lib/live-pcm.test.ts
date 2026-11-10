import { describe, expect, it } from "vitest";

const modulePath = "../../public/qwen-live-worklet.js";
const dsp: typeof import("../../public/qwen-live-worklet.js") = await import(/* @vite-ignore */ modulePath).catch(() => ({}) as never);
const sine = (rate: number, hz: number, seconds: number, amplitude = 0.5) =>
  Float32Array.from({ length: rate * seconds }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);

describe("streaming PCM conversion", () => {
  it("packs continuous capture into 20 ms little-endian PCM16 frames", () => {
    expect(dsp.Pcm16Framer).toBeTypeOf("function");
    const framer = new dsp.Pcm16Framer(320);
    expect(framer.push(Float32Array.from([2, -2, 0.5]))).toEqual([]);
    const frames = framer.push(new Float32Array(638));
    expect(frames.map((frame: ArrayBuffer) => frame.byteLength)).toEqual([640, 640]);
    const bytes = new DataView(frames[0]);
    expect([bytes.getInt16(0, true), bytes.getInt16(2, true), bytes.getInt16(4, true)]).toEqual([32767, -32768, 16384]);
    expect(framer.push(new Float32Array(319))).toHaveLength(1);
  });
  it.each([48_000, 44_100])("preserves a 1 kHz, half-amplitude sine at %i Hz when converting to 16 kHz", (rate) => {
    expect(dsp.StreamingResampler).toBeTypeOf("function");
    const output = new dsp.StreamingResampler(rate, 16_000);
    const samples = output.push(sine(rate, 1_000, 0.2));
    const steady = samples.slice(100);
    expect(rms(steady)).toBeCloseTo(0.5 / Math.sqrt(2), 2);
    const crossings = steady.reduce((n, value, i) => n + Number(i > 0 && steady[i - 1] <= 0 && value > 0), 0);
    expect(crossings / (steady.length / 16_000)).toBeCloseTo(1_000, -1);
  });

  it.each([48_000, 44_100])("filters a 12 kHz input before downsampling from %i Hz", (rate) => {
    const samples = new dsp.StreamingResampler(rate, 16_000).push(sine(rate, 12_000, 0.2)).slice(100);
    expect(rms(samples)).toBeLessThan(0.005);
  });

  it.each([[44_100, 16_000], [24_000, 48_000]])("keeps %i → %i Hz conversion continuous across render quanta", (inputRate, outputRate) => {
    const input = sine(inputRate, 1_000, 0.2);
    const full = new dsp.StreamingResampler(inputRate, outputRate).push(input);
    const streaming = new dsp.StreamingResampler(inputRate, outputRate);
    const chunks: number[] = [];
    for (let i = 0; i < input.length; i += 128) chunks.push(...streaming.push(input.slice(i, i + 128)));
    expect(chunks).toHaveLength(full.length);
    expect(Math.max(...chunks.map((x, i) => Math.abs(x - full[i])))).toBeLessThan(0.0003);
    expect(rms(full.slice(100))).toBeCloseTo(0.5 / Math.sqrt(2), 2);
    const steady = full.slice(100);
    const crossings = steady.reduce((n, value, i) => n + Number(i > 0 && steady[i - 1] <= 0 && value > 0), 0);
    expect(Math.abs(crossings / (steady.length / outputRate) - 1_000)).toBeLessThan(8);
  });
});
