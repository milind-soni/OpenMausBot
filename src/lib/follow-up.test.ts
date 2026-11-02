import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEND_KEYS } from "./send-key";

vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
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

const keys = (init: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, ...init });

describe("the other follow-up's key", () => {
  it("is Ctrl/⌘ with the send key, and Shift too when Ctrl/⌘+Enter already sends", async () => {
    const { alternateSend } = await import("./follow-up");
    for (const mode of SEND_KEYS) {
      expect(alternateSend(keys(), mode), mode).toBe(false);
      expect(alternateSend(keys({ shiftKey: true }), mode), mode).toBe(false);
    }
    for (const mode of ["enter", "shift-enter"] as const) {
      expect(alternateSend(keys({ ctrlKey: true }), mode)).toBe(true);
      expect(alternateSend(keys({ metaKey: true }), mode)).toBe(true);
    }
    expect(alternateSend(keys({ ctrlKey: true }), "mod-enter")).toBe(false);
    expect(alternateSend(keys({ metaKey: true }), "mod-enter")).toBe(false);
    expect(alternateSend(keys({ ctrlKey: true, shiftKey: true }), "mod-enter")).toBe(true);
    expect(alternateSend(keys({ metaKey: true, shiftKey: true }), "mod-enter")).toBe(true);
  });

  it("is named for the platform", async () => {
    const { alternateSendLabel } = await import("./follow-up");
    expect(alternateSendLabel("enter", true)).toBe("⌘+Enter");
    expect(alternateSendLabel("shift-enter", false)).toBe("Ctrl+Enter");
    expect(alternateSendLabel("mod-enter", true)).toBe("⌘+Shift+Enter");
    expect(alternateSendLabel("mod-enter", false)).toBe("Ctrl+Shift+Enter");
  });
});

describe("the follow-up setting", () => {
  it("steers until the person picks queue, and remembers the pick on this device", async () => {
    let setting = await import("./follow-up");
    expect(setting.useFollowUpDefault()).toBe("steer");
    setting.setFollowUpDefault("queue");
    expect(local.getItem(setting.FOLLOW_UP_KEY)).toBe("queue");
    expect(setting.useFollowUpDefault()).toBe("queue");
    vi.resetModules();
    setting = await import("./follow-up");
    expect(setting.readFollowUpDefault()).toBe("queue");
    setting.setFollowUpDefault("steer");
    expect(setting.readFollowUpDefault()).toBe("steer");
  });

  it("falls back to steering on a stored value it does not know, or storage it cannot read", async () => {
    local.setItem("omb-follow-up", "restart");
    const setting = await import("./follow-up");
    expect(setting.readFollowUpDefault()).toBe("steer");
    vi.resetModules();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    expect((await import("./follow-up")).readFollowUpDefault()).toBe("steer");
  });
});
