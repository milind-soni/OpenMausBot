import { afterEach, expect, it, vi } from "vitest";

async function fixture() {
  let Processor: any;
  const postMessage = vi.fn();
  class Base { port = { postMessage, onmessage: null as any }; }
  vi.stubGlobal("AudioWorkletProcessor", Base);
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal("currentTime", 0);
  vi.stubGlobal("registerProcessor", (name: string, processor: unknown) => {
    expect(name).toBe("qwen-live-capture");
    Processor = processor;
  });
  vi.resetModules();
  await import("../../public/qwen-live-worklet.js");
  expect(Processor).toBeTypeOf("function");
  const worklet = new Processor();
  let quanta = 0;
  const process = (count: number) => {
    for (let q = 0; q < count; q++) {
      vi.stubGlobal("currentTime", quanta++ * 128 / 48_000);
      worklet.process([[new Float32Array(128).fill(0.5)]]);
    }
  };
  const credit = (frames: number) => worklet.port.onmessage({ data: { type: "capture.credit", frames } });
  return { worklet, process, credit, postMessage };
}
afterEach(() => vi.unstubAllGlobals());

it("emits timestamped transferred 20 ms PCM16 only after bounded frame credit and stops on release", async () => {
  const { worklet, process, credit, postMessage } = await fixture();
  process(20);
  expect(postMessage).not.toHaveBeenCalled();
  credit(50);
  process(20);
  expect(postMessage).toHaveBeenCalled();
  let previous = -1;
  for (const [frame, transfers] of postMessage.mock.calls) {
    expect(frame.type).toBe("capture.frame");
    expect(frame.pcm).toBeInstanceOf(ArrayBuffer);
    expect(frame.pcm.byteLength).toBe(640);
    expect(transfers).toEqual([frame.pcm]);
    expect(frame.capturedAt).toBeGreaterThanOrEqual(0);
    expect(frame.capturedAt).toBeGreaterThan(previous);
    expect(frame.capturedAt).toBeLessThanOrEqual(40 * 128 / 48_000);
    expect(new DataView(frame.pcm).getInt16(300, true)).toBeCloseTo(16384, -1);
    previous = frame.capturedAt;
  }
  worklet.port.onmessage({ data: "release" });
  const count = postMessage.mock.calls.length;
  expect(worklet.process([[new Float32Array(128)]])).toBe(false);
  expect(postMessage).toHaveBeenCalledTimes(count);
});

it("caps the main-thread backlog at 50 frames then reports one overrun and never skips into a new utterance", async () => {
  const { worklet, process, credit, postMessage } = await fixture();
  credit(50); credit(50);
  process(500);
  const frames = postMessage.mock.calls.filter(([message]) => message.type === "capture.frame");
  expect(frames).toHaveLength(50);
  expect(postMessage.mock.calls.filter(([message]) => message.type === "capture.overrun")).toEqual([[{ type: "capture.overrun" }]]);
  const count = postMessage.mock.calls.length;
  credit(50); process(1_000);
  expect(postMessage).toHaveBeenCalledTimes(count);
  worklet.port.onmessage({ data: "release" });
  expect(worklet.process([])).toBe(false);
});

it("advances timestamps before transfer detaches the capture buffer", async () => {
  const { process, credit, postMessage } = await fixture();
  postMessage.mockImplementation((message, transfers) => { if (transfers) structuredClone(message, { transfer: transfers }); });
  credit(50); process(30);
  const frames = postMessage.mock.calls.filter(([message]) => message.type === "capture.frame");
  expect(frames.length).toBeGreaterThan(2);
  expect(frames[1][0].capturedAt - frames[0][0].capturedAt).toBeCloseTo(0.02, 8);
});

it("replenishes only the exact sent frame credit without exceeding one second of in-flight PCM", async () => {
  const { process, credit, postMessage } = await fixture();
  credit(2); process(15);
  expect(postMessage.mock.calls.filter(([message]) => message.type === "capture.frame")).toHaveLength(1);
  credit(1); process(8);
  expect(postMessage.mock.calls.filter(([message]) => message.type === "capture.frame")).toHaveLength(3);
  expect(postMessage.mock.calls.some(([message]) => message.type === "capture.overrun")).toBe(false);
});
