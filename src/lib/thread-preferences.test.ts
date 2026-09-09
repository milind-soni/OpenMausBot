import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => boolean),
  serverSnapshot: undefined as undefined | (() => boolean),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => boolean,
    serverSnapshot: () => boolean,
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

describe("local thread visibility", () => {
  it("defaults on and ignores malformed values without writing anything", async () => {
    const preference = await import("./thread-preferences");
    expect(preference.useShowThreads()).toBe(true);
    expect(hook.serverSnapshot!()).toBe(true);
    for (const value of ["", "false", "broken", "1"]) {
      local.setItem(preference.SHOW_THREADS_KEY, value);
      expect(preference.useShowThreads()).toBe(true);
    }
    local.setItem.mockClear();
    preference.useShowThreads();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("persists both choices through a renderer reload", async () => {
    let preference = await import("./thread-preferences");
    preference.setShowThreads(false);
    expect(local.getItem(preference.SHOW_THREADS_KEY)).toBe("0");
    expect(preference.useShowThreads()).toBe(false);

    vi.resetModules();
    preference = await import("./thread-preferences");
    expect(preference.useShowThreads()).toBe(false);
    preference.setShowThreads(true);
    expect(local.getItem(preference.SHOW_THREADS_KEY)).toBe("1");
    vi.resetModules();
    preference = await import("./thread-preferences");
    expect(preference.useShowThreads()).toBe(true);
  });

  it("notifies mounted consumers immediately and unsubscribes cleanly", async () => {
    const preference = await import("./thread-preferences");
    preference.useShowThreads();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = hook.subscribe!(first);
    const unsubscribeSecond = hook.subscribe!(second);
    preference.setShowThreads(false);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe(false);

    unsubscribeFirst();
    preference.setShowThreads(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    preference.setShowThreads(false);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("follows cross-window changes and clear, ignoring other storage", async () => {
    const preference = await import("./thread-preferences");
    preference.useShowThreads();
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    local.setItem(preference.SHOW_THREADS_KEY, "0");
    storageEvent(preference.SHOW_THREADS_KEY);
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe(false);

    storageEvent("other-key");
    storageEvent(preference.SHOW_THREADS_KEY, memoryStorage());
    expect(listener).toHaveBeenCalledOnce();

    local.clear();
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hook.snapshot!()).toBe(true);
    unsubscribe();
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each(["getter", "read", "write", "missing"])("keeps the choice usable when storage fails at %s", async (failure) => {
    if (failure === "getter") {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    } else if (failure === "missing") {
      vi.stubGlobal("localStorage", undefined);
    } else {
      if (failure === "write") local.setItem.mockImplementation(() => { throw new Error("blocked"); });
      if (failure === "read") local.getItem.mockImplementation(() => { throw new Error("blocked"); });
    }
    const preference = await import("./thread-preferences");
    expect(preference.useShowThreads()).toBe(true);
    preference.setShowThreads(false);
    expect(preference.useShowThreads()).toBe(false);
    preference.setShowThreads(true);
    expect(preference.useShowThreads()).toBe(true);
  });
});
