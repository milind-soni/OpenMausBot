import { describe, expect, it } from "vitest";

import {
  MENU_BAR_POPOVER_HEIGHT,
  MENU_BAR_POPOVER_WIDTH,
  menuBarPopoverBounds,
  menuBarSurfaceUrl,
} from "./menu-bar-geometry.mjs";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

describe("menuBarSurfaceUrl", () => {
  it("tags the renderer so the compact shell mounts", () => {
    expect(menuBarSurfaceUrl("http://127.0.0.1:5199/")).toBe(
      "http://127.0.0.1:5199/?surface=menubar",
    );
  });
});

describe("menuBarPopoverBounds", () => {
  it("opens under a macOS menu-bar icon and stays on the display", () => {
    const bounds = menuBarPopoverBounds({
      tray: { x: 1200, y: 0, width: 22, height: 22 },
      workArea,
    });
    expect(bounds.width).toBe(MENU_BAR_POPOVER_WIDTH);
    expect(bounds.height).toBe(MENU_BAR_POPOVER_HEIGHT);
    expect(bounds.y).toBeGreaterThan(22);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.width - 8);
  });

  it("opens above a Windows/Linux tray on the bottom edge", () => {
    const bounds = menuBarPopoverBounds({
      tray: { x: 1300, y: 868, width: 24, height: 24 },
      workArea,
    });
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(868);
    expect(bounds.x).toBeGreaterThanOrEqual(8);
  });
});
