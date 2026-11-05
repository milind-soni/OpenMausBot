import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { fishSpeech } from "./fish-speech";
import { fishListeningReady, listensHere, speechBridge } from "./speech";

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

  it("needs no key for the Mac's own recognizer, and nothing where dictation is unavailable", () => {
    expect(listensHere(withDictation(APPLE), null)).toBe(true);
    expect(listensHere(withDictation({ available: false, engine: "none", onDevice: false }), savedFish)).toBe(false);
  });
});
