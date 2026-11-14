import { describe, expect, it, vi } from "vitest";

import { computerPanelTabs, readComputerPanelView, resolveComputerPanelView, writeComputerPanelView } from "./computer-panel-view";

describe("computer panel view persistence", () => {
  it("restores the browser for the same bot after the expanded workspace closes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeComputerPanelView("sprout", "browser", storage);

    expect(readComputerPanelView("sprout", storage)).toBe("browser");
    expect(readComputerPanelView("another-bot", storage)).toBe("computer");
  });

  it("falls back safely for stale values or blocked storage", () => {
    expect(readComputerPanelView("sprout", { getItem: () => "unknown" })).toBe("computer");
    expect(readComputerPanelView("sprout", { getItem: () => { throw new Error("blocked"); } })).toBe("computer");

    const setItem = vi.fn(() => { throw new Error("blocked"); });
    expect(() => writeComputerPanelView("sprout", "browser", { setItem })).not.toThrow();
  });

  it("remembers a bot's routines tab without changing another bot's view", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeComputerPanelView("scout", "routines", storage);
    expect(readComputerPanelView("scout", storage)).toBe("routines");
    expect(readComputerPanelView("other", storage)).toBe("computer");
  });

  it("round-trips the Data tab", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeComputerPanelView("scout", "data", storage);
    expect(readComputerPanelView("scout", storage)).toBe("data");
  });
});

describe("computer panel view availability", () => {
  it("drops the Android tab once its device disconnects", () => {
    expect(resolveComputerPanelView("android", { advanced: true, androidConnected: true })).toBe("android");
    expect(resolveComputerPanelView("android", { advanced: true, androidConnected: false })).toBe("computer");
  });

  it("drops the tabs the current mode does not render", () => {
    expect(resolveComputerPanelView("routines", { advanced: false, androidConnected: false })).toBe("computer");
    expect(resolveComputerPanelView("files", { advanced: true, androidConnected: true })).toBe("computer");
  });

  it("shows Simple the Android tab, after Computer, only while a device is connected", () => {
    expect(computerPanelTabs({ advanced: false, androidConnected: true })).toEqual(["computer", "android", "browser", "data", "files"]);
    expect(computerPanelTabs({ advanced: false, androidConnected: false })).toEqual(["computer", "browser", "data", "files"]);
    expect(resolveComputerPanelView("android", { advanced: false, androidConnected: true })).toBe("android");
    expect(resolveComputerPanelView("android", { advanced: false, androidConnected: false })).toBe("computer");
  });

  it("keeps a view whose trigger is on the row", () => {
    for (const view of ["computer", "browser", "data"] as const) {
      expect(resolveComputerPanelView(view, { advanced: true, androidConnected: true })).toBe(view);
      expect(resolveComputerPanelView(view, { advanced: false, androidConnected: false })).toBe(view);
    }
    expect(resolveComputerPanelView("files", { advanced: false, androidConnected: false })).toBe("files");
  });
});
