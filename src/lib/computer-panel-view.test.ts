import { describe, expect, it, vi } from "vitest";

import { readComputerPanelView, writeComputerPanelView } from "./computer-panel-view";

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
});
