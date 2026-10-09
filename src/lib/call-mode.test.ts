import { afterEach, describe, expect, it, vi } from "vitest";

import { CALL_MODE_KEY, CALL_MODES, callModeHint, effectiveCallMode, liveDisclosure, parseCallMode } from "./call-mode";
import { t } from "./i18n";
import { localeChoices, locales } from "@/locales";

describe("call mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to taking turns and accepts only known modes", () => {
    expect(parseCallMode(null)).toBe("turns");
    expect(parseCallMode("live")).toBe("live");
    expect(parseCallMode("LIVE")).toBe("turns");
    expect(CALL_MODES.map((mode) => t(mode.label))).toEqual(["Take turns", "Live"]);
  });

  // Turning Live on is where the person learns what leaves the computer.
  it("says, where Live is chosen, what a Live call sends to OpenAI", () => {
    const live = callModeHint("live");
    expect(live).toContain("A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays on your computer.");
    expect(callModeHint("turns")).toBe("You talk, then the bot answers in its own voice. Listening stays on this computer.");
  });

  // On the person's Cloud the key is saved on the Cloud, not this computer.
  it("says the OpenAI key stays on the Cloud when the chat is on the person's Cloud", () => {
    const live = callModeHint("live", { cloudHome: true });
    expect(live).toContain("A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays on My Cloud.");
    expect(live).not.toContain("your computer");
    expect(liveDisclosure({ cloudHome: true })).toBe(t("call.live.disclosureCloud"));
    expect(liveDisclosure({ cloudHome: false })).toBe(t("call.live.disclosure"));
  });

  // Where the chat runs changes one sentence, never the language: a pack
  // translates the Cloud wording only where it translates this computer's.
  it("writes both disclosures in the same language in every pack", () => {
    for (const { code } of localeChoices) {
      const pack = locales[code];
      expect(Object.hasOwn(pack, "call.live.disclosureCloud"), code).toBe(Object.hasOwn(pack, "call.live.disclosure"));
    }
  });

  // Where this device can't take turns (a browser, a Windows or Linux app,
  // any server's or Cloud's page), a call that can be Live is Live, whatever
  // was picked before: Take turns there is a button that can never start.
  it("makes the call Live wherever taking turns can't run, and keeps the choice where it can", () => {
    for (const stored of ["turns", "live"] as const) {
      expect(effectiveCallMode(stored, { turnsHere: false, canLive: true }), stored).toBe("live");
      expect(effectiveCallMode(stored, { turnsHere: true, canLive: true }), stored).toBe(stored);
      // a room has no Live call: nothing to switch to
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
});
