import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listLocalSystemVoices,
  localSystemVoiceActive,
  localSystemVoicesAvailable,
  remoteSystemVoice,
  remoteVoiceProvider,
  resolveLocalSystemVoice,
  setRemoteSystemVoice,
  setRemoteVoiceProvider,
} from "./local-voice";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const voices = [
  { voiceURI: "com.apple.voice.samantha", name: "Samantha", lang: "en-US" },
  { voiceURI: "com.apple.voice.daniel", name: "Daniel", lang: "en-GB" },
] as SpeechSynthesisVoice[];

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", {
    ogb: { platform: "darwin", remoteClient: { active: true } },
    SpeechSynthesisUtterance: class {},
    speechSynthesis: { getVoices: () => voices },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("paired desktop voice preferences", () => {
  it("defaults a paired Mac to its local installed voices", () => {
    expect(localSystemVoicesAvailable()).toBe(true);
    expect(remoteVoiceProvider()).toBe("system");
    expect(localSystemVoiceActive()).toBe(true);
    expect(listLocalSystemVoices()).toEqual([
      { id: "com.apple.voice.samantha", label: "Samantha", description: "en-US" },
      { id: "com.apple.voice.daniel", label: "Daniel", description: "en-GB" },
    ]);
  });

  it("keeps engine and per-agent voice choices on this device", () => {
    setRemoteSystemVoice("bot-1", "com.apple.voice.samantha");
    expect(remoteSystemVoice("bot-1")).toBe("com.apple.voice.samantha");
    expect(resolveLocalSystemVoice("com.apple.voice.samantha")).toBe(voices[0]);

    setRemoteVoiceProvider("host");
    expect(remoteVoiceProvider()).toBe("host");
    expect(localSystemVoiceActive()).toBe(false);
    expect(remoteSystemVoice("bot-1")).toBe("com.apple.voice.samantha");
  });

  it("never offers Mac voices on a Windows client", () => {
    vi.stubGlobal("window", {
      ogb: { platform: "win32", remoteClient: { active: true } },
      SpeechSynthesisUtterance: class {},
      speechSynthesis: { getVoices: () => voices },
    });
    expect(localSystemVoicesAvailable()).toBe(false);
    expect(listLocalSystemVoices()).toEqual([]);
  });
});
