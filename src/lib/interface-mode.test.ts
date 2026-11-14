import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

let local: ReturnType<typeof memoryStorage>;

// The module keeps a per-session choice, so each case loads a fresh copy over the same storage, as a relaunch would.
// simpleOnly false is the switch put back (simple-only.ts), which keeps the old rules.
async function fresh(simpleOnly = false) {
  vi.resetModules();
  vi.doMock("./simple-only", () => ({ SIMPLE_ONLY: simpleOnly }));
  return import("./interface-mode");
}

beforeEach(() => {
  local = memoryStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.doUnmock("./simple-only");
  vi.unstubAllGlobals();
});

describe("with Simple the only mode", () => {
  it("reads Advanced as off whatever this browser stored, and never turns it on", async () => {
    local.setItem("omb-skin", "lagoon");
    local.setItem("omb-advanced-mode", "1");
    const { readAdvancedMode, setAdvancedMode } = await fresh(true);
    expect(readAdvancedMode()).toBe(false);
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(false);
    expect(local.getItem("omb-advanced-mode")).toBe("1");
  });

  it("ships with the switch off: Advanced mode can be turned on, and stays on", async () => {
    vi.resetModules();
    expect((await vi.importActual<typeof import("./simple-only")>("./simple-only")).SIMPLE_ONLY).toBe(false);
    const { readAdvancedMode, setAdvancedMode } = await import("./interface-mode");
    expect(readAdvancedMode()).toBe(false);
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(true);
    expect(local.getItem("omb-advanced-mode")).toBe("1");
    vi.resetModules();
    expect((await import("./interface-mode")).readAdvancedMode(), "after a relaunch").toBe(true);
  });
});

describe("with the switch back", () => {
  it("defaults a fresh install to Simple and stores that once", async () => {
    const { readAdvancedMode, settleAdvancedModeDefault, ADVANCED_MODE_KEY } = await fresh();
    expect(readAdvancedMode()).toBe(false);
    settleAdvancedModeDefault();
    local.setItem("omb-skin", "midnight");
    expect(local.getItem(ADVANCED_MODE_KEY)).toBe("0");
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });

  it("defaults an existing install to Advanced so an update hides nothing", async () => {
    local.setItem("omb-skin", "lagoon");
    const { readAdvancedMode, settleAdvancedModeDefault, ADVANCED_MODE_KEY } = await fresh();
    expect(readAdvancedMode()).toBe(true);
    settleAdvancedModeDefault();
    expect(local.getItem(ADVANCED_MODE_KEY)).toBe("1");
  });

  it("keeps an explicit choice over the existing-install default", async () => {
    local.setItem("omb-skin", "midnight");
    (await fresh()).setAdvancedMode(false);
    expect((await fresh()).readAdvancedMode()).toBe(false);
  });

  it("still switches for the session when storage throws", async () => {
    const { setAdvancedMode, readAdvancedMode } = await fresh();
    local.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(true);
  });

  it("falls back to Simple when storage cannot be read at all", async () => {
    local.getItem.mockImplementation(() => {
      throw new Error("blocked");
    });
    const { readAdvancedMode, settleAdvancedModeDefault } = await fresh();
    expect(() => settleAdvancedModeDefault()).not.toThrow();
    expect(readAdvancedMode()).toBe(false);
  });
});
