import { describe, expect, it } from "vitest";

import { windowChromeOptions } from "./window-chrome.mjs";

describe("window chrome", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  it("uses Window Controls Overlay on Windows, without frame:false", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 26 },
    });
  });

  it("keeps Linux window chrome native", () => {
    expect(windowChromeOptions("linux")).toEqual({});
  });
});
