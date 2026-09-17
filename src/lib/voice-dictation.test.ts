import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceDictationSession } from "./voice-dictation";
import { createDictationCapture, type DictationCaptureOptions } from "./dictation-capture";

vi.mock("./dictation-capture", () => ({
  DICTATION_UNAVAILABLE: "Handy unavailable",
  createDictationCapture: vi.fn(),
}));

function sessionHarness() {
  const captures: ReturnType<typeof mockCapture>[] = [];
  function mockCapture(options: DictationCaptureOptions) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { options, resolve, reject, start: vi.fn(() => pending), discard: vi.fn(),
      transcribe: vi.fn().mockResolvedValue("hello"), setMuted: vi.fn() };
  }
  vi.mocked(createDictationCapture).mockImplementation((options) => {
    const capture = mockCapture(options);
    captures.push(capture);
    return capture;
  });
  const setInterval = vi.fn(() => 1);
  vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
  const callbacks = { onResult: vi.fn(), onError: vi.fn(), onActiveChange: vi.fn(), onTranscribing: vi.fn() };
  const session = createVoiceDictationSession(callbacks);
  return { session, captures, callbacks, setInterval };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("voice session races", () => {
  it("stop during starting discards and never arms a timer on late open", async () => {
    const h = sessionHarness();
    const starting = h.session.start();
    h.session.stop();
    expect(h.captures[0].discard).toHaveBeenCalled();
    h.captures[0].resolve();
    await starting;
    expect(h.session.state.phase).toBe("idle");
    expect(h.setInterval).not.toHaveBeenCalled();
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it("an old start rejection cannot clear or report over a newer capture", async () => {
    const h = sessionHarness();
    const old = h.session.start();
    h.session.stop();
    const next = h.session.start();
    h.captures[1].resolve();
    await next;
    h.captures[0].reject(new Error("permission denied"));
    await old;
    expect(h.session.state.phase).toBe("listening");
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.session.dispose();
    expect(h.captures[1].discard).toHaveBeenCalled();
  });
});

import {
  INITIAL_VOICE_DICTATION_STATE,
  MAX_DICTATION_MS,
  SILENCE_CHUNKS_TO_STOP,
  SILENCE_RMS_THRESHOLD,
  isSilentLevel,
  mergeDictatedText,
  rmsOf,
  shouldAutoStop,
  shouldForceStop,
  stepVoiceDictation,
} from "./voice-dictation";

describe("rmsOf", () => {
  it("is zero for silence and empty input", () => {
    expect(rmsOf(new Float32Array(256))).toBe(0);
    expect(rmsOf([])).toBe(0);
  });

  it("is the root mean square of the samples", () => {
    // A constant ±1 square wave has RMS 1, not 0 like its mean would be.
    const square = new Float32Array(64).map((_, i) => (i % 2 === 0 ? 1 : -1));
    expect(rmsOf(square)).toBeCloseTo(1, 5);
  });
});

describe("isSilentLevel", () => {
  it("treats a quiet room as silence and speech as not", () => {
    expect(isSilentLevel(SILENCE_RMS_THRESHOLD - 0.001)).toBe(true);
    expect(isSilentLevel(SILENCE_RMS_THRESHOLD)).toBe(false);
    expect(isSilentLevel(0.2)).toBe(false);
  });
});

describe("stepVoiceDictation", () => {
  it("begin moves to starting and stamps the clock", () => {
    const next = stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "begin", now: 1000 });
    expect(next.phase).toBe("starting");
    expect(next.startedAt).toBe(1000);
  });

  it("opened only promotes from starting", () => {
    const starting = stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "begin", now: 0 });
    expect(stepVoiceDictation(starting, { type: "opened" }).phase).toBe("listening");
    // late socket open after a stop must not resurrect listening
    const stopped = { ...starting, phase: "finalizing" as const };
    expect(stepVoiceDictation(stopped, { type: "opened" }).phase).toBe("finalizing");
    expect(stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "opened" }).phase).toBe("idle");
  });

  it("partials stream while listening and finalizing, never while idle", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const };
    expect(stepVoiceDictation(listening, { type: "partial", text: "hello" }).partial).toBe("hello");
    const finalizing = { ...listening, phase: "finalizing" as const };
    expect(stepVoiceDictation(finalizing, { type: "partial", text: "hello there" }).partial).toBe("hello there");
    expect(stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "partial", text: "hello" }).partial).toBe("");
  });

  it("utterance arms the silence watchdog only while listening", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const };
    const armed = stepVoiceDictation(listening, { type: "utterance" });
    expect(armed.heardUtterance).toBe(true);
    expect(armed.silentChunks).toBe(0);
    expect(stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "utterance" }).heardUtterance).toBe(false);
    // reset on a fresh begin — the previous run's endpoint must not carry over
    expect(stepVoiceDictation(armed, { type: "begin", now: 5 }).heardUtterance).toBe(false);
  });

  it("silence counts only after an utterance, and voiced chunks reset the count", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const };
    // no utterance heard yet: background noise does not count toward stop
    const noised = stepVoiceDictation(listening, { type: "level", rms: 0.001 });
    expect(noised.silentChunks).toBe(0);
    const armed = stepVoiceDictation(listening, { type: "utterance" });
    const one = stepVoiceDictation(armed, { type: "level", rms: 0.001 });
    expect(one.silentChunks).toBe(1);
    const two = stepVoiceDictation(one, { type: "level", rms: 0.002 });
    expect(two.silentChunks).toBe(2);
    // speech again: watchdog restarts
    const reset = stepVoiceDictation(two, { type: "level", rms: 0.2 });
    expect(reset.silentChunks).toBe(0);
  });

  it("fail returns to idle with the message and drops the partial", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const, partial: "half a sentence" };
    const failed = stepVoiceDictation(listening, { type: "fail", message: "stream died" });
    expect(failed.phase).toBe("idle");
    expect(failed.error).toBe("stream died");
    expect(failed.partial).toBe("");
  });

  it("stop finalizes from listening or starting only", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const };
    expect(stepVoiceDictation(listening, { type: "stop", now: 1 }).phase).toBe("finalizing");
    const starting = stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "begin", now: 0 });
    expect(stepVoiceDictation(starting, { type: "stop", now: 1 }).phase).toBe("finalizing");
    const finalizing = { ...listening, phase: "finalizing" as const };
    expect(stepVoiceDictation(finalizing, { type: "stop", now: 2 }).phase).toBe("finalizing");
    expect(stepVoiceDictation(INITIAL_VOICE_DICTATION_STATE, { type: "stop", now: 3 }).phase).toBe("idle");
  });

  it("finish lands idle and clears the running transcript", () => {
    const finalizing = { ...INITIAL_VOICE_DICTATION_STATE, phase: "finalizing" as const, partial: "text", startedAt: 9 };
    const done = stepVoiceDictation(finalizing, { type: "finish", text: "text" });
    expect(done.phase).toBe("idle");
    expect(done.partial).toBe("");
    expect(done.startedAt).toBe(0);
  });

  it("reset returns the exact initial state", () => {
    expect(stepVoiceDictation({ ...INITIAL_VOICE_DICTATION_STATE, phase: "finalizing" }, { type: "reset" })).toEqual(INITIAL_VOICE_DICTATION_STATE);
  });
});

describe("shouldAutoStop", () => {
  it("fires only with an utterance heard and enough silence since", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const };
    expect(shouldAutoStop(listening)).toBe(false);
    const armed = stepVoiceDictation(listening, { type: "utterance" });
    let state = armed;
    for (let i = 1; i < SILENCE_CHUNKS_TO_STOP; i += 1) state = stepVoiceDictation(state, { type: "level", rms: 0.001 });
    expect(shouldAutoStop(state)).toBe(false);
    state = stepVoiceDictation(state, { type: "level", rms: 0.001 });
    expect(shouldAutoStop(state)).toBe(true);
    // a finalizing session can never re-fire
    expect(shouldAutoStop({ ...state, phase: "finalizing" })).toBe(false);
  });
});

describe("shouldForceStop", () => {
  it("trips past the hard cap in listening or finalizing, not before", () => {
    const listening = { ...INITIAL_VOICE_DICTATION_STATE, phase: "listening" as const, startedAt: 0 };
    expect(shouldForceStop(listening, MAX_DICTATION_MS)).toBe(false);
    expect(shouldForceStop(listening, MAX_DICTATION_MS + 1)).toBe(true);
    const starting = { ...listening, phase: "starting" as const };
    expect(shouldForceStop(starting, MAX_DICTATION_MS + 1)).toBe(false);
    const finalizing = { ...listening, phase: "finalizing" as const };
    expect(shouldForceStop(finalizing, MAX_DICTATION_MS + 1)).toBe(true);
  });
});

describe("mergeDictatedText", () => {
  it("appends dictated text after what was typed with one space", () => {
    expect(mergeDictatedText("hello", "world")).toBe("hello world");
    expect(mergeDictatedText("hello  ", "world")).toBe("hello world");
    expect(mergeDictatedText("  hello", "  world ")).toBe("  hello world");
  });

  it("keeps the base when dictation heard nothing", () => {
    expect(mergeDictatedText("hello", "")).toBe("hello");
    expect(mergeDictatedText("hello", "   ")).toBe("hello");
  });

  it("takes the dictation alone when the composer was empty", () => {
    expect(mergeDictatedText("", "world")).toBe("world");
    expect(mergeDictatedText("   ", "world")).toBe("world");
  });
});
