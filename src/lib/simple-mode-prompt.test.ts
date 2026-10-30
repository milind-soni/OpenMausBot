// Whether this browser has closed the Simple mode popup: kept in its own storage, as the mode is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let storage: Map<string, string>;
const load = async () => {
  vi.resetModules();
  return import("./simple-mode-prompt");
};

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("the Simple mode popup's seen flag", () => {
  it("is unset in a browser that never closed it, and set for good once it is closed", async () => {
    const prompt = await load();
    expect(prompt.SIMPLE_MODE_PROMPT_KEY).toBe("omb-simple-mode-prompt");
    expect(prompt.simpleModePromptSeen()).toBe(false);
    prompt.markSimpleModePromptSeen();
    expect(storage.get("omb-simple-mode-prompt")).toBe("1");
    expect((await load()).simpleModePromptSeen(), "a later launch reads it back").toBe(true);
  });

  it("never asks a browser whose storage it cannot read, and stays closed for the session where it cannot write", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect((await load()).simpleModePromptSeen()).toBe(true);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full"); } });
    const prompt = await load();
    expect(prompt.simpleModePromptSeen()).toBe(false);
    prompt.markSimpleModePromptSeen();
    expect(prompt.simpleModePromptSeen()).toBe(true);
  });
});
