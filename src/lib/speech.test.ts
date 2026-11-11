import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { recordedSpeech } from "./recorded-speech";
import { serverListeningReady, listensHere, speechBridge } from "./speech";

const withDictation = (dictation: DesktopCapabilities["dictation"]): DesktopCapabilities =>
  ({ ...initialDesktopCapabilities(), dictation });
const FISH = { available: true, engine: "fish-audio", onDevice: false } as const;
const APPLE = { available: true, engine: "apple-speech", onDevice: true } as const;
const savedFish = { savedKeys: { fishAudioKey: { configured: true } } } as unknown as ConfigStatus;
const BROWSER = { available: false, engine: "none", onDevice: false, reasonCode: "desktop-app-required" } as const;
const microphone = () => vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });

afterEach(() => {
  vi.unstubAllGlobals();
  cacheDesktopCapabilities(initialDesktopCapabilities());
});

describe("speechBridge", () => {
  it("uses the recorder on Macs when a server provider is explicitly selected", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    microphone();
    cacheDesktopCapabilities(withDictation(APPLE));
    for (const provider of ["openai", "fish", "gemini"] as const) {
      const config = { stt: { provider, configured: true } } as ConfigStatus;
      expect(speechBridge(config)).toBe(recordedSpeech);
      expect(listensHere(withDictation(APPLE), config)).toBe(true);
      expect(listensHere(withDictation(APPLE), { stt: { provider, configured: false } } as ConfigStatus)).toBe(false);
    }
    expect(speechBridge({ stt: { provider: "auto" } } as ConfigStatus)).toBe(ogb);
  });
  it("is the page's own Fish Audio listener where the engine is fish-audio", () => {
    vi.stubGlobal("window", { ogb: { speechStart: vi.fn() } });
    cacheDesktopCapabilities(withDictation(FISH));
    expect(speechBridge()).toBe(recordedSpeech);
  });

  it("is the desktop app's helper everywhere else", () => {
    const ogb = { speechStart: vi.fn() };
    vi.stubGlobal("window", { ogb });
    cacheDesktopCapabilities(withDictation(APPLE));
    expect(speechBridge()).toBe(ogb);
  });

  it("records in the page in a browser, where no desktop helper exists", () => {
    vi.stubGlobal("window", {});
    expect(speechBridge()).toBe(recordedSpeech);
  });
});

describe("listening readiness", () => {
  it("accepts configured compatible transcription without a Fish key", () => {
    microphone();
    const config = { stt: { provider: "openai", configured: true, keyConfigured: false } } as ConfigStatus;
    expect(serverListeningReady(config)).toBe(true);
    expect(listensHere(withDictation(FISH), config)).toBe(true);
  });
  it("needs a saved Fish Audio key to listen through Fish Audio", () => {
    microphone();
    expect(serverListeningReady(savedFish)).toBe(true);
    expect(serverListeningReady(null)).toBe(false);
    expect(listensHere(withDictation(FISH), savedFish)).toBe(true);
    expect(listensHere(withDictation(FISH), null)).toBe(false);
  });

  it("needs no key for the Mac's own recognizer, and nothing where dictation is unavailable", () => {
    expect(listensHere(withDictation(APPLE), null)).toBe(true);
    expect(listensHere(withDictation(BROWSER), savedFish)).toBe(false);
  });

  it("listens through the server's speech input in a browser page that can reach the microphone", () => {
    const config = { stt: { provider: "openai", configured: true } } as ConfigStatus;
    expect(listensHere(withDictation(BROWSER), config)).toBe(false);
    microphone();
    expect(listensHere(withDictation(BROWSER), config)).toBe(true);
    expect(listensHere(withDictation(BROWSER), { stt: { provider: "openai", configured: false } } as ConfigStatus)).toBe(false);
  });
});
