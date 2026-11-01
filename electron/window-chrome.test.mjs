import { describe, expect, it } from "vitest";

import { windowBackground, windowChromeOptions } from "./window-chrome.mjs";

describe("window chrome", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 7 },
    });
  });

  it("hides the native title bar on Windows; caption buttons are renderer-drawn", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
    });
  });

  it("keeps Linux window chrome native", () => {
    expect(windowChromeOptions("linux")).toEqual({});
  });

  it("with the frame turned off, opens macOS's traffic lights where the frame-less window keeps them, and gives Windows its own title bar back", () => {
    expect(windowChromeOptions("darwin", false)).toEqual({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } });
    expect(windowChromeOptions("win32", false), "the system's title bar and caption buttons").toEqual({});
    expect(windowChromeOptions("linux", false)).toEqual({});
  });

  it("paints the light or dark canvas before the renderer loads", () => {
    expect(windowBackground(true)).toBe("#121212");
    expect(windowBackground(false)).toBe("#fcfcfc");
  });
});
