import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "./onboarding";
import { clearWelcomeDraft, profilePatch, readWelcomeDraft, saveWelcomeDraft, WELCOME_DRAFT_KEY } from "./welcome-draft";

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

describe("profilePatch", () => {
  it("saves a typed name, trimmed", () => {
    expect(profilePatch({ name: " Ada " })).toEqual({ profile: { name: "Ada" } });
  });

  it("never writes a blank, and saves nothing already saved", () => {
    expect(profilePatch({ name: "" })).toBeNull();
    expect(profilePatch({ name: "  " }, { name: "Ada" })).toBeNull();
    expect(profilePatch({ name: "Ada" }, { name: "Ada" })).toBeNull();
    expect(profilePatch({ name: "Ada L" }, { name: "Ada" })).toEqual({ profile: { name: "Ada L" } });
  });

  it("never touches the email: the welcome no longer asks for one", () => {
    const fields = { name: "Ada", email: "ada@example.com" } as unknown as Parameters<typeof profilePatch>[0];
    expect(profilePatch(fields)).toEqual({ profile: { name: "Ada" } });
  });
});

describe("the welcome draft", () => {
  it("keeps the step and the typed name across a reload, until it is cleared", () => {
    expect(readWelcomeDraft()).toBeNull();
    saveWelcomeDraft({ beat: "engines", name: "Ada" });
    expect(readWelcomeDraft()).toEqual({ beat: "engines", name: "Ada" });
    expect(Object.keys(JSON.parse(local.values.get(WELCOME_DRAFT_KEY)!)).sort()).toEqual(["beat", "name", "version"]);
    clearWelcomeDraft();
    expect(readWelcomeDraft()).toBeNull();
    expect(local.values.has(WELCOME_DRAFT_KEY)).toBe(false);
  });

  it("reads a draft from before, which also held an email, and leaves the email out", () => {
    local.values.set(WELCOME_DRAFT_KEY, JSON.stringify({ version: WELCOME_VERSION, beat: "engines", name: "Ada", email: "ada@exa" }));
    expect(readWelcomeDraft()).toEqual({ beat: "engines", name: "Ada" });
  });

  it("forgets a draft written by another version of the welcome", () => {
    saveWelcomeDraft({ beat: "engines", name: "Ada" });
    expect(JSON.parse(local.values.get(WELCOME_DRAFT_KEY)!).version).toBe(WELCOME_VERSION);
    for (const version of [undefined, WELCOME_VERSION - 1, WELCOME_VERSION + 1]) {
      local.values.set(WELCOME_DRAFT_KEY, JSON.stringify({ version, beat: "engines", name: "Ada" }));
      expect(readWelcomeDraft(), String(version)).toBeNull();
    }
  });

  it("ignores anything it did not write, such as a step from an older welcome", () => {
    for (const junk of ["{", "null", "[]", JSON.stringify({ version: WELCOME_VERSION, beat: "reel", name: "Ada" }),
      JSON.stringify({ version: WELCOME_VERSION, beat: "hello", name: 3 }), JSON.stringify({ version: WELCOME_VERSION, beat: "hello", name: "x".repeat(2000) })]) {
      local.values.set(WELCOME_DRAFT_KEY, junk);
      expect(readWelcomeDraft(), junk.slice(0, 40)).toBeNull();
    }
  });

  it("works on without browser storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(readWelcomeDraft()).toBeNull();
    expect(() => saveWelcomeDraft({ beat: "hello", name: "" })).not.toThrow();
    expect(() => clearWelcomeDraft()).not.toThrow();
  });
});
