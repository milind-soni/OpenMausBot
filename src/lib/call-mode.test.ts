import { afterEach, describe, expect, it, vi } from "vitest";

import { CALL_MODE_KEY, CALL_MODES, callModeHint, effectiveCallMode, liveDisclosure, liveKeyFormKey, parseCallMode } from "./call-mode";
import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { t } from "./i18n";
import { localeChoices, locales } from "@/locales";
import type { ConfigStatus } from "@/state/store";

describe("call mode", () => {
  afterEach(() => {
    cacheDesktopCapabilities(initialDesktopCapabilities());
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to taking turns and accepts only known modes", () => {
    expect(parseCallMode(null)).toBe("turns");
    expect(parseCallMode("live")).toBe("live");
    expect(parseCallMode("LIVE")).toBe("turns");
    expect(CALL_MODES.map((mode) => t(mode.label))).toEqual(["Take turns", "Live"]);
  });

  it("says, where Live is chosen, what a Live call sends to OpenAI", () => {
    const live = callModeHint("live");
    expect(live).toContain("A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays on your computer.");
    expect(callModeHint("turns")).toBe("You talk, then the bot answers in its own voice. Listening stays on this computer.");
  });

  it("says the voice leaves this computer in Take turns once the person picked ElevenLabs to hear them", () => {
    const chosen = { tts: { hearWith: "elevenlabs" }, savedKeys: { ttsKey: { configured: true } } } as unknown as ConfigStatus;
    const dictation = { available: true, engine: "apple-speech", onDevice: true } as const;
    cacheDesktopCapabilities({ ...initialDesktopCapabilities(), dictation });
    expect(callModeHint("turns", { config: chosen })).toBe("You talk, then the bot answers in its own voice. ElevenLabs turns what you say into text, so your voice goes there.");
    expect(callModeHint("turns", { config: { tts: {} } as unknown as ConfigStatus })).toBe(t("call.mode.turnsHint"));
    cacheDesktopCapabilities({ ...initialDesktopCapabilities(), dictation: { ...dictation, available: false } });
    expect(callModeHint("turns", { config: chosen })).toBe(t("call.mode.turnsHint"));
  });

  it("says the OpenAI key stays on the Cloud when the chat is on the person's Cloud", () => {
    const live = callModeHint("live", { cloudHome: true });
    expect(live).toContain("A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays in the Cloud.");
    expect(live).not.toContain("your computer");
    expect(liveDisclosure({ cloudHome: true })).toBe(t("call.live.disclosureCloud"));
    expect(liveDisclosure({ cloudHome: false })).toBe(t("call.live.disclosure"));
  });

  it("writes both disclosures in the same language in every pack", () => {
    for (const { code } of localeChoices) {
      const pack = locales[code];
      expect(Object.hasOwn(pack, "call.live.disclosureCloud"), code).toBe(Object.hasOwn(pack, "call.live.disclosure"));
    }
  });

  it("makes the call Live wherever taking turns can't run, and keeps the choice where it can", () => {
    for (const stored of ["turns", "live"] as const) {
      expect(effectiveCallMode(stored, { turnsHere: false, canLive: true }), stored).toBe("live");
      expect(effectiveCallMode(stored, { turnsHere: true, canLive: true }), stored).toBe(stored);
      expect(effectiveCallMode(stored, { turnsHere: false, canLive: false }), stored).toBe(stored);
    }
  });

  it("remembers the choice and survives storage that refuses writes", async () => {
    const stored = new Map<string, string>([[CALL_MODE_KEY, "live"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
    const mode = await import("./call-mode");
    expect(mode.callMode()).toBe("live");
    mode.setCallMode("turns");
    expect(stored.get(CALL_MODE_KEY)).toBe("turns");

    vi.resetModules();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const blocked = await import("./call-mode");
    expect(blocked.callMode()).toBe("turns");
    blocked.setCallMode("live");
    expect(blocked.callMode()).toBe("live");
  });
  it("ties a Live key form to the provider and, for Azure or a custom endpoint, to its address", () => {
    expect(liveKeyFormKey(undefined)).toBe("openai");
    expect(liveKeyFormKey({ provider: "fish" })).toBe("fish");
    expect(liveKeyFormKey({ provider: "custom", customEndpoint: "https://a.example.com/v1" })).toBe("custom|https://a.example.com/v1");
    expect(liveKeyFormKey({ provider: "azure", azureEndpoint: "https://r.openai.azure.com", customEndpoint: "https://a.example.com/v1" })).toBe("azure|https://r.openai.azure.com");
    expect(liveKeyFormKey({ provider: "custom" })).toBe("custom");
  });
});
