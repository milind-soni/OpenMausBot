import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./window-pref-changes", () => ({ windowPrefChanged: vi.fn() }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
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

describe("send when dictation stops", () => {
  it("is off until the person turns it on", async () => {
    const preference = await import("./send-after-dictation");
    expect(preference.sendsAfterDictation()).toBe(false);
    preference.setSendAfterDictation(true);
    expect(local.getItem(preference.SEND_AFTER_DICTATION_KEY)).toBe("1");
    expect(preference.sendsAfterDictation()).toBe(true);
  });

  it("follows the saved choice once it is saved, so another window turning it off is not missed", async () => {
    const preference = await import("./send-after-dictation");
    preference.setSendAfterDictation(true);
    // Another window turns it off while no composer here listens for storage events.
    local.setItem(preference.SEND_AFTER_DICTATION_KEY, "0");
    expect(preference.sendsAfterDictation()).toBe(false);
  });

  it("keeps the choice for this window when it cannot be saved", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full"); } });
    const preference = await import("./send-after-dictation");
    preference.setSendAfterDictation(true);
    expect(preference.sendsAfterDictation()).toBe(true);
  });
});
