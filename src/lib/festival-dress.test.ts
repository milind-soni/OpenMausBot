import { describe, expect, it } from "vitest";

import { DRESS_UP_KEY, readDressUp, setDressUp, wornBody } from "./festival-dress";

describe("festival dress-up", () => {
  it("leaves bots alone unless dressed", () => {
    expect(wornBody("star", "orange", null)).toBe("star");
    expect(wornBody(null, "orange", null)).toBeUndefined();
  });

  it("puts each colour in its costume for the festival it is dressed for", () => {
    expect(wornBody("star", "orange", "halloween")).toBe("pumpkin");
    expect(wornBody(undefined, "purple", "halloween")).toBe("ghost");
    expect(wornBody("star", "orange", "diwali")).toBe("laddu");
    expect(wornBody(undefined, "red", "diwali")).toBe("rocket");
  });

  it("leaves a silver bot in its own body while dressed", () => {
    expect(wornBody("cursor", "silver", "diwali")).toBe("cursor");
    expect(wornBody(undefined, "silver", "halloween")).toBeUndefined();
    expect(wornBody("cursor", "chrome", "diwali")).toBe("cursor");
  });

  it("keeps a body from the same festival the bot already chose, and dresses over any other", () => {
    expect(wornBody("vampire", "orange", "halloween")).toBe("vampire");
    expect(wornBody("jalebi", "orange", "diwali")).toBe("jalebi");
    expect(wornBody("vampire", "orange", "diwali")).toBe("laddu");
    expect(wornBody("jalebi", "orange", "halloween")).toBe("pumpkin");
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
      expect(store.get(DRESS_UP_KEY)).toBe("0");
      expect(readDressUp()).toBe(false);
      setDressUp(true);
      expect(readDressUp()).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
