import { afterEach, describe, expect, it, vi } from "vitest";

import { LAST_CONVERSATION_KEY, readLastConversation, rememberConversation } from "./last-conversation";

/** A storage surface the test fills and reads back, the way the app does. */
const surface = (initial: Record<string, string> = {}) => {
  const stored = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    stored,
  };
};

describe("last conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("readLastConversation returns null with nothing stored", () => {
    vi.stubGlobal("localStorage", surface());
    expect(readLastConversation()).toBeNull();
  });

  it("readLastConversation ignores a corrupt value", () => {
    // a record left behind by an interrupted write, and one that is not a
    // conversation id at all: both read as absent rather than resuming
    vi.stubGlobal("localStorage", surface({ [LAST_CONVERSATION_KEY]: "   " }));
    expect(readLastConversation()).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => 42, setItem: () => {} });
    expect(readLastConversation()).toBeNull();
  });

  it("rememberConversation round-trips through storage", () => {
    const store = surface();
    vi.stubGlobal("localStorage", store);
    rememberConversation("room-7");
    expect(store.stored.get(LAST_CONVERSATION_KEY)).toBe("room-7");
    expect(readLastConversation()).toBe("room-7");
  });

  it("a throwing storage surface never breaks reads or writes", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLastConversation()).toBeNull();
    expect(() => rememberConversation("bot-1")).not.toThrow();
  });
});
