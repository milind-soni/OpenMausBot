import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newLineKeyLabel, SEND_KEYS, sendKeyLabel, sendsMessage, type SendKey } from "./send-key";

const hook = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => SendKey),
  serverSnapshot: undefined as undefined | (() => SendKey),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => SendKey,
    serverSnapshot: () => SendKey,
  ) => {
    Object.assign(hook, { subscribe, snapshot, serverSnapshot });
    return snapshot();
  },
}));

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...overrides,
});

describe("which Enter sends", () => {
  it("sends on Enter and leaves Shift+Enter a new line by default", () => {
    expect(sendsMessage(key(), "enter")).toBe(true);
    expect(sendsMessage(key({ shiftKey: true }), "enter")).toBe(false);
  });

  it("sends on Shift+Enter and leaves Enter a new line in Shift+Enter mode", () => {
    expect(sendsMessage(key({ shiftKey: true }), "shift-enter")).toBe(true);
    expect(sendsMessage(key(), "shift-enter")).toBe(false);
  });

  it("makes Enter and Shift+Enter a new line in Ctrl+Enter mode", () => {
    expect(sendsMessage(key(), "mod-enter")).toBe(false);
    expect(sendsMessage(key({ shiftKey: true }), "mod-enter")).toBe(false);
  });

  it.each(SEND_KEYS)("always sends on Ctrl+Enter and ⌘+Enter (%s mode)", (mode) => {
    expect(sendsMessage(key({ ctrlKey: true }), mode)).toBe(true);
    expect(sendsMessage(key({ metaKey: true }), mode)).toBe(true);
    expect(sendsMessage(key({ ctrlKey: true, shiftKey: true }), mode)).toBe(true);
  });

  it.each(SEND_KEYS)("never sends while an input method is composing (%s mode)", (mode) => {
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(sendsMessage(key({ ...modifiers, isComposing: true }), mode)).toBe(false);
      // WebKit's confirming Enter arrives after compositionend, still as 229
      expect(sendsMessage(key({ ...modifiers, keyCode: 229 }), mode)).toBe(false);
    }
  });

  it.each(SEND_KEYS)("ignores every other key (%s mode)", (mode) => {
    for (const other of ["a", "Tab", "Escape", "Process"]) {
      for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
        expect(sendsMessage(key({ key: other, ...modifiers }), mode)).toBe(false);
      }
    }
  });

  it("names the keys the way each platform writes them", () => {
    expect(sendKeyLabel("enter", true)).toBe("Enter");
    expect(sendKeyLabel("enter", false)).toBe("Enter");
    expect(sendKeyLabel("shift-enter", true)).toBe("Shift+Enter");
    expect(sendKeyLabel("shift-enter", false)).toBe("Shift+Enter");
    expect(sendKeyLabel("mod-enter", true)).toBe("⌘+Enter");
    expect(sendKeyLabel("mod-enter", false)).toBe("Ctrl+Enter");
    expect(SEND_KEYS.map(newLineKeyLabel)).toEqual(["Shift+Enter", "Enter", "Enter"]);
  });
});

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

describe("the local send key choice", () => {
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

  it("defaults to Enter and ignores malformed values without writing anything", async () => {
    const preference = await import("./send-key");
    expect(preference.useSendKey()).toBe("enter");
    expect(hook.serverSnapshot!()).toBe("enter");
    for (const value of ["", "ctrl", "Mod-Enter", "shift", "Shift-Enter", "1"]) {
      local.setItem(preference.SEND_KEY_KEY, value);
      expect(preference.useSendKey()).toBe("enter");
    }
    local.setItem.mockClear();
    preference.useSendKey();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("persists every choice through a renderer reload", async () => {
    for (const mode of [...SEND_KEYS, "enter"] as const) {
      let preference = await import("./send-key");
      preference.setSendKey(mode);
      expect(local.getItem(preference.SEND_KEY_KEY)).toBe(mode);
      expect(preference.useSendKey()).toBe(mode);
      vi.resetModules();
      preference = await import("./send-key");
      expect(preference.useSendKey()).toBe(mode);
    }
  });

  it("notifies mounted composers immediately and unsubscribes cleanly", async () => {
    const preference = await import("./send-key");
    preference.useSendKey();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = hook.subscribe!(first);
    const unsubscribeSecond = hook.subscribe!(second);
    preference.setSendKey("mod-enter");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("mod-enter");

    unsubscribeFirst();
    preference.setSendKey("enter");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    preference.setSendKey("mod-enter");
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("follows cross-window changes and clear, ignoring other storage", async () => {
    const preference = await import("./send-key");
    preference.useSendKey();
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    local.setItem(preference.SEND_KEY_KEY, "shift-enter");
    storageEvent(preference.SEND_KEY_KEY);
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("shift-enter");

    storageEvent("other-key");
    storageEvent(preference.SEND_KEY_KEY, memoryStorage());
    expect(listener).toHaveBeenCalledOnce();

    local.clear();
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hook.snapshot!()).toBe("enter");
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
    const preference = await import("./send-key");
    expect(preference.useSendKey()).toBe("enter");
    for (const mode of [...SEND_KEYS, "enter"] as const) {
      preference.setSendKey(mode);
      expect(preference.useSendKey()).toBe(mode);
    }
  });
});
