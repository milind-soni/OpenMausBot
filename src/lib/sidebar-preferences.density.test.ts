import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar header and Settings → Appearance share one density store; these
// tests pin that a change from either side reaches every mounted consumer.
const hook = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => string),
  serverSnapshot: undefined as undefined | (() => string),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => string,
    serverSnapshot: () => string,
  ) => {
    Object.assign(hook, { subscribe, snapshot, serverSnapshot });
    return snapshot();
  },
}));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

let local: ReturnType<typeof memoryStorage>;
let browser: EventTarget;

function storageEvent(key: string | null, storageArea: unknown = local) {
  browser.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea }));
}

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  browser = new EventTarget();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared sidebar density store", () => {
  it("defaults to comfortable and reads a density saved before the first render", async () => {
    const preference = await import("./sidebar-preferences");
    expect(preference.useSidebarDensity()).toBe("comfortable");
    expect(hook.serverSnapshot!()).toBe("comfortable");
    preference.saveSidebarDensity("compact");
    expect(preference.useSidebarDensity()).toBe("compact");
  });

  it("persists a choice and notifies every mounted consumer", async () => {
    const preference = await import("./sidebar-preferences");
    preference.useSidebarDensity();
    const sidebar = vi.fn();
    const settings = vi.fn();
    const unsubscribeSidebar = hook.subscribe!(sidebar);
    const unsubscribeSettings = hook.subscribe!(settings);

    preference.setSidebarDensity("icons");
    expect(local.getItem(preference.SIDEBAR_DENSITY_KEY)).toBe("icons");
    expect(sidebar).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("icons");

    unsubscribeSidebar();
    preference.setSidebarDensity("compact");
    expect(sidebar).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledTimes(2);
    unsubscribeSettings();

    vi.resetModules();
    const reloaded = await import("./sidebar-preferences");
    expect(reloaded.useSidebarDensity()).toBe("compact");
  });

  it("follows another window's change, ignoring unrelated storage", async () => {
    const preference = await import("./sidebar-preferences");
    preference.setSidebarDensity("compact");
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);

    local.setItem(preference.SIDEBAR_DENSITY_KEY, "icons");
    storageEvent(preference.SIDEBAR_DENSITY_KEY);
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("icons");

    storageEvent("other-key");
    storageEvent(preference.SIDEBAR_DENSITY_KEY, memoryStorage());
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("keeps the choice for this session when storage rejects writes", async () => {
    local.setItem.mockImplementation(() => { throw new Error("blocked"); });
    const preference = await import("./sidebar-preferences");
    preference.setSidebarDensity("icons");
    expect(preference.useSidebarDensity()).toBe("icons");
  });
});
