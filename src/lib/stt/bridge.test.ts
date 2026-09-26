import { afterEach, describe, expect, it, vi } from "vitest";

import { endCall, startCall } from "../call";
import { effectiveDictation, speechBridge, speechEndNote } from "./bridge";

function nativeOgb() {
  return {
    platform: "darwin",
    speechStart: vi.fn(async () => {}),
    speechStop: vi.fn(async () => {}),
    speechFinish: vi.fn(async () => {}),
    onSpeechTranscript: vi.fn(() => () => {}),
    onSpeechEnd: vi.fn(() => () => {}),
  };
}

const unsupported = { available: false, engine: "none", onDevice: false, reasonCode: "unsupported-platform" } as const;
const ready = { provider: "local", ready: true, openaiConfigured: false, groqConfigured: false, xaiConfigured: false, baseUrl: "http://x", model: "", language: "", interim: true } as const;

afterEach(() => {
  endCall();
  vi.unstubAllGlobals();
});

describe("speech bridge on macOS", () => {
  it("passes every call straight through to the native helper", async () => {
    const ogb = nativeOgb();
    vi.stubGlobal("window", { ogb });
    const bridge = speechBridge()!;
    expect(bridge.kind).toBe("native");
    await bridge.start({ endpointMs: 850 });
    await bridge.finish();
    await bridge.stop();
    expect(ogb.speechStart).toHaveBeenCalledWith({ endpointMs: 850 });
    expect(ogb.speechFinish).toHaveBeenCalled();
    expect(ogb.speechStop).toHaveBeenCalled();
  });

  it("still stops the helper on hang-up", () => {
    const ogb = nativeOgb();
    vi.stubGlobal("window", { ogb });
    startCall("bot");
    ogb.speechStop.mockClear();
    endCall("bot");
    expect(ogb.speechStop).toHaveBeenCalledTimes(1);
  });

  it("never upgrades dictation on a Mac", () => {
    vi.stubGlobal("window", { ogb: nativeOgb() });
    expect(effectiveDictation(unsupported, ready)).toBe(unsupported);
  });
});

describe("speech bridge on Windows and Linux", () => {
  it("uses the universal engine", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    expect(speechBridge()?.kind).toBe("universal");
  });

  it("makes calls available once speech recognition is ready", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    expect(effectiveDictation(unsupported, ready)).toEqual({ available: true, engine: "universal", onDevice: true });
    expect(effectiveDictation(unsupported, { ...ready, provider: "groq" }).onDevice).toBe(false);
  });

  it("asks for setup instead of saying 'macOS only' when nothing is configured", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    expect(effectiveDictation(unsupported, undefined).reasonCode).toBe("stt-setup-required");
  });

  it("leaves remote and browser restrictions alone", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    const remote = { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } as const;
    expect(effectiveDictation(remote, ready)).toBe(remote);
  });

  it("only rewrites universal failure notes", () => {
    expect(speechEndNote({ code: 1, reason: "mic-permission", message: "Blocked." })).toBe("Blocked.");
    expect(speechEndNote({ code: 1, reason: "helper-build-failed" })).toBeNull();
  });
});
