import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillBurgerEnabled, threadTabsEnabled } from "./feature-flags";

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

describe("Settings → Features on this device", () => {
  it("starts with thread notes and mascot animations on", async () => {
    const switches = await import("./feature-switches");
    expect(switches.readDeviceFeature("threadNotes")).toBe(true);
    expect(switches.readDeviceFeature("mascotMotion")).toBe(true);
  });

  it("keeps a switch off across a restart, and on again once turned back on", async () => {
    let switches = await import("./feature-switches");
    switches.setDeviceFeature("mascotMotion", false);
    vi.resetModules();
    switches = await import("./feature-switches");
    expect(switches.readDeviceFeature("mascotMotion")).toBe(false);
    expect(switches.readDeviceFeature("threadNotes")).toBe(true);
    switches.setDeviceFeature("mascotMotion", true);
    vi.resetModules();
    switches = await import("./feature-switches");
    expect(switches.readDeviceFeature("mascotMotion")).toBe(true);
  });

  it("stays on when this device's storage cannot be read", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    const switches = await import("./feature-switches");
    expect(switches.readDeviceFeature("threadNotes")).toBe(true);
  });
});

describe("Settings → Features in the place's config.json", () => {
  it("has Skill Burger on and thread tabs off until config.json says otherwise", () => {
    expect(skillBurgerEnabled(null)).toBe(true);
    expect(skillBurgerEnabled({ features: {} })).toBe(true);
    expect(skillBurgerEnabled({ features: { skillBurger: false } })).toBe(false);
    expect(threadTabsEnabled(null)).toBe(false);
    expect(threadTabsEnabled({ features: { threadTabs: true } })).toBe(true);
  });
});
