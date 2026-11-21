import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_RECORDING_MAX_MS } from "../../shared/deepseek-voice";
import type { ConfigStatus } from "@/state/store";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { createEndpointer, fishSpeech } from "./fish-speech";
import { CALL_ENDPOINT_MS, fishListeningReady, listensHere, missingListenKey, recordsClips, scribeChosen, speechBridge } from "./speech";

const withDictation = (dictation: DesktopCapabilities["dictation"]): DesktopCapabilities =>
  ({ ...initialDesktopCapabilities(), dictation });
const FISH = { available: true, engine: "fish-audio", onDevice: false } as const;
const APPLE = { available: true, engine: "apple-speech", onDevice: true } as const;
const savedFish = { savedKeys: { fishAudioKey: { configured: true } } } as unknown as ConfigStatus;

afterEach(() => {
  vi.unstubAllGlobals();
  cacheDesktopCapabilities(initialDesktopCapabilities());
});

describe("speechBridge", () => {
  it("is the page's own Fish Audio listener where the engine is fish-audio", () => {
    vi.stubGlobal("window", { ogb: { speechStart: vi.fn() } });
    cacheDesktopCapabilities(withDictation(FISH));
    expect(speechBridge(null)).toBe(fishSpeech);
  });

  it("is the desktop app's helper everywhere else", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    expect(speechBridge(null)).toBe(ogb);
  });

  it("is nothing in a browser", () => {
    vi.stubGlobal("window", {});
    expect(speechBridge(null)).toBeUndefined();
  });
});

describe("DeepSeek listening", () => {
  const deepseek = { tts: { provider: "deepseek" }, savedKeys: { fishAudioKey: { configured: true } } } as unknown as ConfigStatus;
  const deepseekSaved = { ...deepseek, deepseek: { configured: true } } as unknown as ConfigStatus;

  it("records in the page on the Mac too, instead of the native recognizer, while DeepSeek is the voice", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    const bridge = speechBridge(deepseekSaved);
    expect(bridge).not.toBe(ogb);
    expect(recordsClips(bridge)).toBe(true);
    expect(speechBridge(savedFish)).toBe(ogb);
    expect(recordsClips(ogb as never)).toBe(false);
  });

  it("needs the DeepSeek key, not a Fish key, and still nothing where dictation is unavailable", () => {
    expect(listensHere(withDictation(APPLE), deepseek)).toBe(false);
    expect(missingListenKey(withDictation(APPLE), deepseek)).toBe("deepseek");
    expect(missingListenKey(withDictation(FISH), deepseek)).toBe("deepseek");
    expect(listensHere(withDictation(FISH), deepseekSaved)).toBe(true);
    expect(missingListenKey(withDictation(FISH), null)).toBe("fish");
    expect(listensHere(withDictation({ available: false, engine: "none", onDevice: false }), deepseekSaved)).toBe(false);
    vi.stubGlobal("window", {});
    expect(speechBridge(deepseekSaved)).toBeUndefined();
  });
});

describe("manual recording cap", () => {
  it("ends a DeepSeek clip under 120 seconds even with frame rounding, and leaves the default cap alone", () => {
    const FRAME = 64;
    const framesUntilDone = (maxMs?: number) => {
      const heard = createEndpointer(undefined, FRAME, maxMs);
      let frames = 1;
      while (heard(0.1) !== "done") frames += 1;
      return frames;
    };
    expect(framesUntilDone(DEEPSEEK_RECORDING_MAX_MS) * FRAME).toBeLessThan(120_000);
    expect(framesUntilDone(DEEPSEEK_RECORDING_MAX_MS) * FRAME).toBeGreaterThanOrEqual(DEEPSEEK_RECORDING_MAX_MS);
    expect(framesUntilDone() * FRAME).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe("listening readiness", () => {
  it("needs a saved Fish Audio key to listen through Fish Audio", () => {
    expect(fishListeningReady(savedFish)).toBe(true);
    expect(fishListeningReady(null)).toBe(false);
    expect(listensHere(withDictation(FISH), savedFish)).toBe(true);
    expect(listensHere(withDictation(FISH), null)).toBe(false);
  });

  it("listens through the person's own ElevenLabs key, but not the plan's included voice", () => {
    const ownEleven = { savedKeys: { ttsKey: { configured: true } } } as unknown as ConfigStatus;
    const includedEleven = { savedKeys: { ttsKey: { configured: true } }, tts: { included: true } } as unknown as ConfigStatus;
    expect(fishListeningReady(ownEleven)).toBe(true);
    expect(listensHere(withDictation(FISH), ownEleven)).toBe(true);
    expect(fishListeningReady(includedEleven)).toBe(false);
  });

  it("needs no key for the Mac's own recognizer, and nothing where dictation is unavailable", () => {
    expect(listensHere(withDictation(APPLE), null)).toBe(true);
    expect(listensHere(withDictation({ available: false, engine: "none", onDevice: false }), savedFish)).toBe(false);
  });
});

describe("hearing through ElevenLabs Scribe by choice", () => {
  const chosen = { tts: { hearWith: "elevenlabs" }, savedKeys: { ttsKey: { configured: true } } } as unknown as ConfigStatus;

  it("records in the page on the Mac too, over DeepSeek, once the person picks ElevenLabs with their own key", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    const deepseekToo = { ...chosen, tts: { provider: "deepseek", hearWith: "elevenlabs" } } as unknown as ConfigStatus;
    expect(speechBridge(chosen)).toBe(fishSpeech);
    expect(speechBridge(deepseekToo)).toBe(fishSpeech);
    expect(scribeChosen(deepseekToo)).toBe(true);
    expect(listensHere(withDictation(APPLE), deepseekToo)).toBe(true);
    expect(missingListenKey(withDictation(APPLE), deepseekToo)).toBeNull();
  });

  it("changes nothing without the choice, or with only the plan's included voice", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    const notChosen = { savedKeys: { ttsKey: { configured: true } } } as unknown as ConfigStatus;
    const included = { ...chosen, tts: { hearWith: "elevenlabs", included: true } } as unknown as ConfigStatus;
    expect(speechBridge(notChosen)).toBe(ogb);
    expect(speechBridge(included)).toBe(ogb);
    expect(scribeChosen(included)).toBe(false);
  });
});

describe("CALL_ENDPOINT_MS", () => {
  const FRAME = 64;
  const run = (endpoint: number, quietMs: number) => {
    const heard = createEndpointer(endpoint, FRAME);
    for (let i = 0; i < 10; i += 1) heard(0.1);
    let last = heard(0);
    for (let quiet = FRAME; quiet < quietMs; quiet += FRAME) last = heard(0);
    return last;
  };

  it("keeps listening through a short thinking pause in a call", () => {
    expect(CALL_ENDPOINT_MS).toBeGreaterThanOrEqual(1_500);
    expect(run(CALL_ENDPOINT_MS, 1_200)).toBe("speaking");
  });

  it("still ends the turn once the person has stopped speaking", () => {
    expect(CALL_ENDPOINT_MS).toBeLessThanOrEqual(2_500);
    expect(run(CALL_ENDPOINT_MS, CALL_ENDPOINT_MS + FRAME)).toBe("done");
  });
});
