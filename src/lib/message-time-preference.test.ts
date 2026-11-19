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

describe("always showing message times", () => {
  it("defaults off and ignores malformed values without writing anything", async () => {
    const preference = await import("./message-time-preference");
    expect(preference.useAlwaysShowMessageTimes()).toBe(false);
    expect(hook.serverSnapshot!()).toBe(false);
    for (const value of ["", "true", "broken", "0"]) {
      local.setItem(preference.MESSAGE_TIMES_KEY, value);
      expect(preference.useAlwaysShowMessageTimes()).toBe(false);
    }
    local.setItem.mockClear();
    preference.useAlwaysShowMessageTimes();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("persists both choices through a renderer reload", async () => {
    let preference = await import("./message-time-preference");
    preference.setAlwaysShowMessageTimes(true);
    expect(local.getItem(preference.MESSAGE_TIMES_KEY)).toBe("1");
    expect(preference.useAlwaysShowMessageTimes()).toBe(true);

    vi.resetModules();
    preference = await import("./message-time-preference");
    expect(preference.useAlwaysShowMessageTimes()).toBe(true);
    preference.setAlwaysShowMessageTimes(false);
    expect(local.getItem(preference.MESSAGE_TIMES_KEY)).toBe("0");
    vi.resetModules();
    preference = await import("./message-time-preference");
    expect(preference.useAlwaysShowMessageTimes()).toBe(false);
  });

  it("notifies mounted consumers immediately and unsubscribes cleanly", async () => {
    const preference = await import("./message-time-preference");
    preference.useAlwaysShowMessageTimes();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = hook.subscribe!(first);
    const unsubscribeSecond = hook.subscribe!(second);
    preference.setAlwaysShowMessageTimes(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe(true);

    unsubscribeFirst();
    preference.setAlwaysShowMessageTimes(false);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    preference.setAlwaysShowMessageTimes(true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("follows cross-window changes and clear, ignoring other storage", async () => {
    const preference = await import("./message-time-preference");
    preference.useAlwaysShowMessageTimes();
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    local.setItem(preference.MESSAGE_TIMES_KEY, "1");
    storageEvent(preference.MESSAGE_TIMES_KEY);
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe(true);

    storageEvent("other-key");
    storageEvent(preference.MESSAGE_TIMES_KEY, memoryStorage());
    expect(listener).toHaveBeenCalledOnce();

    local.clear();
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hook.snapshot!()).toBe(false);
    unsubscribe();
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rereads storage when a window subscribes again after missing a change", async () => {
    const preference = await import("./message-time-preference");
    const unsubscribe = hook.subscribe!(vi.fn());
    preference.setAlwaysShowMessageTimes(true);
    unsubscribe();
    local.setItem(preference.MESSAGE_TIMES_KEY, "0");
    storageEvent(preference.MESSAGE_TIMES_KEY);
    const again = hook.subscribe!(vi.fn());
    expect(hook.snapshot!()).toBe(false);
    again();
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
    const preference = await import("./message-time-preference");
    expect(preference.useAlwaysShowMessageTimes()).toBe(false);
    preference.setAlwaysShowMessageTimes(true);
    expect(preference.useAlwaysShowMessageTimes()).toBe(true);
    preference.setAlwaysShowMessageTimes(false);
    expect(preference.useAlwaysShowMessageTimes()).toBe(false);
  });
});
