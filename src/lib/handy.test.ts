// Handy is both Astra's dictation engine and another application's install, so
// two things are worth pinning here: where Astra thinks Handy lives, and which
// model Astra asks it to run. The advice rule is pinned by hardware tier — a
// model that cannot decode faster than the user speaks is a broken feature on
// the machine that picked it, so the tiers are the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handyAdviceInstalled,
  handyModel,
  handyPath,
  recommendHandyModel,
  setHandyModel,
  setHandyPath,
} from "./handy";

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => store.clear());
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

const device = (cores: number, ramGB: number) => ({
  platform: "win32",
  arch: "x64",
  cpu: "fixture cpu",
  cores,
  ramGB,
});

describe("stored preferences", () => {
  it("keeps the executable path and the pinned model apart", () => {
    setHandyPath("%LOCALAPPDATA%\\Handy\\handy.exe");
    setHandyModel("handy-computer/parakeet-tdt-0.6b-v3-int8");
    expect(handyPath()).toBe("%LOCALAPPDATA%\\Handy\\handy.exe");
    expect(handyModel()).toBe("handy-computer/parakeet-tdt-0.6b-v3-int8");
    // Blank is the documented "let Handy decide" value, not a missing setting.
    setHandyModel("");
    expect(handyModel()).toBe("");
    expect(handyPath()).toBe("%LOCALAPPDATA%\\Handy\\handy.exe");
  });

  it("reads as unset when storage refuses to work", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    expect(handyPath()).toBe("");
    expect(handyModel()).toBe("");
    expect(() => {
      setHandyPath("somewhere");
      setHandyModel("something");
    }).not.toThrow();
  });
});

describe("recommendHandyModel", () => {
  it("picks the lightest model on a minimal machine", () => {
    const advice = recommendHandyModel(device(2, 4));
    expect(advice.label).toBe("Moonshine V2 Small");
    expect(advice.reasonKey).toBe("settings.wakeWord.engine.advice.light");
  });

  it("picks an int8 CPU model on a laptop with no GPU to lean on", () => {
    // The machine this rule was written against: 4 cores, 8 GB.
    const advice = recommendHandyModel(device(4, 8));
    expect(advice.label).toBe("Parakeet V2/V3 (int8)");
    expect(advice.needles).toContain("parakeet");
  });

  it("names the whole family, so either installed variant counts as a match", () => {
    const advice = recommendHandyModel(device(8, 16));
    expect(advice.label).toBe("Parakeet V2/V3 (int8)");
    expect(handyAdviceInstalled(advice, ["parakeet-tdt-0.6b-v2-int8"])).toBe(true);
    expect(handyAdviceInstalled(advice, ["parakeet-tdt-0.6b-v3-int8"])).toBe(true);
  });

  it("allows a large Whisper tier only on a big machine", () => {
    const advice = recommendHandyModel(device(16, 32));
    expect(advice.label).toBe("Whisper Large");
    expect(advice.reasonKey).toBe("settings.wakeWord.engine.advice.large");
  });

  it("never sends a small machine to Whisper's large tiers", () => {
    for (const [cores, ramGB] of [[2, 4], [4, 8], [8, 16]]) {
      expect(recommendHandyModel(device(cores, ramGB)).needles).not.toContain("whisper");
    }
  });
});

describe("handyAdviceInstalled", () => {
  const advice = recommendHandyModel(device(4, 8));

  it("finds the advised model among Handy's own ids, ignoring case", () => {
    expect(handyAdviceInstalled(advice, ["handy-computer/Parakeet-TDT-0.6b-V3-int8"])).toBe(true);
  });

  it("ignores the empty selection Handy reports when its settings are unreadable", () => {
    expect(handyAdviceInstalled(advice, [null])).toBe(false);
    expect(handyAdviceInstalled(advice, [])).toBe(false);
    expect(handyAdviceInstalled(advice, [null, "handy-computer/moonshine-v2-small"])).toBe(false);
  });
});
