import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  snapshot: undefined as undefined | (() => boolean),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => {
    hook.snapshot = snapshot;
    return snapshot();
  },
}));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

let local: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("color my messages", () => {
  it("is on until the person turns it off", async () => {
    const preference = await import("./user-bubble-preference");
    expect(preference.readColorUserBubbles()).toBe(true);
    expect(preference.useColorUserBubbles()).toBe(true);
    local.setItem(preference.USER_BUBBLE_COLOR_KEY, "0");
    expect(preference.readColorUserBubbles()).toBe(false);
    local.setItem(preference.USER_BUBBLE_COLOR_KEY, "1");
    expect(preference.readColorUserBubbles()).toBe(true);
  });

  it("stays on when this device's storage cannot be read", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    const preference = await import("./user-bubble-preference");
    expect(preference.readColorUserBubbles()).toBe(true);
  });

  it("remembers the choice on this device", async () => {
    let preference = await import("./user-bubble-preference");
    preference.setColorUserBubbles(true);
    expect(local.getItem(preference.USER_BUBBLE_COLOR_KEY)).toBe("1");
    vi.resetModules();
    preference = await import("./user-bubble-preference");
    expect(preference.readColorUserBubbles()).toBe(true);
    preference.setColorUserBubbles(false);
    expect(local.getItem(preference.USER_BUBBLE_COLOR_KEY)).toBe("0");
    expect(preference.readColorUserBubbles()).toBe(false);
  });
});
