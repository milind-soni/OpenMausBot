import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "./onboarding";
import { clearWelcomeDraft, readWelcomeDraft, saveWelcomeDraft, WELCOME_DRAFT_KEY } from "./welcome-draft";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
let local: ReturnType<typeof storage>;
beforeEach(() => {
  local = storage();
  vi.stubGlobal("localStorage", local);
});
afterEach(() => vi.unstubAllGlobals());

describe("the welcome draft", () => {
  it("keeps the screen across a reload, and nothing else, until it is cleared", () => {
    expect(readWelcomeDraft()).toBeNull();
    saveWelcomeDraft({ beat: "chief" });
    expect(readWelcomeDraft()).toEqual({ beat: "chief" });
    expect(Object.keys(JSON.parse(local.values.get(WELCOME_DRAFT_KEY)!)).sort()).toEqual(["beat", "version"]);
    clearWelcomeDraft();
    expect(readWelcomeDraft()).toBeNull();
    expect(local.values.has(WELCOME_DRAFT_KEY)).toBe(false);
  });

  it("forgets a draft written by another version of the welcome", () => {
    saveWelcomeDraft({ beat: "chief" });
    expect(JSON.parse(local.values.get(WELCOME_DRAFT_KEY)!).version).toBe(WELCOME_VERSION);
    for (const version of [undefined, WELCOME_VERSION - 1, WELCOME_VERSION + 1]) {
      local.values.set(WELCOME_DRAFT_KEY, JSON.stringify({ version, beat: "chief" }));
      expect(readWelcomeDraft(), String(version)).toBeNull();
    }
  });

  it("ignores anything it did not write, such as a step from the longer welcome with a typed name", () => {
    for (const junk of ["{", "null", "[]", JSON.stringify({ version: WELCOME_VERSION, beat: "reel" }),
      JSON.stringify({ version: WELCOME_VERSION, beat: "engines", name: "Ada" }), JSON.stringify({ version: WELCOME_VERSION, beat: "hello", name: "Ada" })]) {
      local.values.set(WELCOME_DRAFT_KEY, junk);
      expect(readWelcomeDraft(), junk.slice(0, 40)).toBeNull();
    }
  });

  it("works on without browser storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(readWelcomeDraft()).toBeNull();
    expect(() => saveWelcomeDraft({ beat: "meet" })).not.toThrow();
    expect(() => clearWelcomeDraft()).not.toThrow();
  });
});
