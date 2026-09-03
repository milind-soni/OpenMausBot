import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { windowChromeOptions } from "./window-chrome.mjs";

describe("window chrome", () => {
  it("keeps Windows and Linux caption controls outside renderer content", () => {
    expect(windowChromeOptions("win32")).toEqual({ frame: true });
    expect(windowChromeOptions("linux")).toEqual({ frame: true });
  });

  it("keeps the macOS inset traffic lights", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  it("keeps the skin IPC as validation-only acknowledgement", () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    expect(main).toContain('ipcMain.handle("desktop:skin", (_event, skin) => isKnownSkin(skin));');
    expect(main).not.toContain("titleBarOverlay");
    expect(main).not.toContain("waitsForSkinSync");
  });
});
