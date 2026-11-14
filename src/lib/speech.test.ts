import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { createEndpointer, fishSpeech } from "./fish-speech";
import { CALL_ENDPOINT_MS, fishListeningReady, listensHere, speechBridge } from "./speech";

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
    expect(speechBridge()).toBe(fishSpeech);
  });

  it("is the desktop app's helper everywhere else", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    expect(speechBridge()).toBe(ogb);
  });

  it("is nothing in a browser", () => {
    vi.stubGlobal("window", {});
    expect(speechBridge()).toBeUndefined();
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
