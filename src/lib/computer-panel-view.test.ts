import { describe, expect, it, vi } from "vitest";

import { readComputerPanelView, writeComputerPanelView } from "./computer-panel-view";

describe("computer panel view persistence", () => {
  it("remembers the chosen view per bot", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeComputerPanelView("sprout", "android", storage);

    expect(readComputerPanelView("sprout", storage)).toBe("android");
    expect(readComputerPanelView("another-bot", storage)).toBe("computer");
  });

  it("falls back safely for stale values or blocked storage", () => {
    // "browser" is a retired view: the built-in browser panel no longer exists.
    expect(readComputerPanelView("sprout", { getItem: () => "browser" })).toBe("computer");
    expect(readComputerPanelView("sprout", { getItem: () => "unknown" })).toBe("computer");
    expect(readComputerPanelView("sprout", { getItem: () => { throw new Error("blocked"); } })).toBe("computer");

    const setItem = vi.fn(() => { throw new Error("blocked"); });
    expect(() => writeComputerPanelView("sprout", "android", { setItem })).not.toThrow();
  });
});
