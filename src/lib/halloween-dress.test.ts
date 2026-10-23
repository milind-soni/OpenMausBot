import { describe, expect, it } from "vitest";

import { HALLOWEEN_DRESS_KEY, readDressUp, setDressUp, wornBody } from "./halloween-dress";

describe("Halloween dress-up", () => {
  it("leaves bots alone unless dressed", () => {
    expect(wornBody("star", "orange", false)).toBe("star");
    expect(wornBody(null, "orange", false)).toBeUndefined();
  });

  it("puts each colour in its costume while dressed", () => {
    expect(wornBody("star", "orange", true)).toBe("pumpkin");
    expect(wornBody(undefined, "purple", true)).toBe("ghost");
  });

  it("leaves a silver bot in its own body while dressed", () => {
    expect(wornBody("cursor", "silver", true)).toBe("cursor");
    expect(wornBody(undefined, "silver", true)).toBeUndefined();
    expect(wornBody("cursor", "chrome", true)).toBe("cursor");
  });

  it("keeps a Halloween body the bot already chose", () => {
    expect(wornBody("vampire", "orange", true)).toBe("vampire");
  });

  it("starts on, and remembers being switched off", () => {
    const store = new Map<string, string>();
    const local = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    try {
      expect(readDressUp()).toBe(true);
      setDressUp(false);
      expect(store.get(HALLOWEEN_DRESS_KEY)).toBe("0");
      expect(readDressUp()).toBe(false);
      setDressUp(true);
      expect(readDressUp()).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
