import { describe, expect, it } from "vitest";

import { windowChromeOptions } from "./window-chrome.mjs";

describe("window chrome", () => {
  it("uses a full-size content view with positioned traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 16 },
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
});
