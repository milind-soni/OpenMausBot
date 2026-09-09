import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const left = { x: -1600, y: 0, width: 1600, height: 900 };

describe("desktop window state", () => {
  it("rejects corrupt and incomplete saved state", () => {
    expect(parseWindowState("not json")).toBeNull();
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 0, height: 700 } })).toBeNull();
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 1000 } })).toBeNull();
  });

  it("restores a reachable window on the display where it was saved", () => {
    expect(
      resolveWindowState(
        { bounds: { x: -1500, y: 40, width: 1200, height: 760 }, maximized: true },
        [primary, left],
      ),
    ).toEqual({ bounds: { x: -1500, y: 40, width: 1200, height: 760 }, maximized: true });
  });

  it("centers an off-screen window on the primary display and clamps its size", () => {
    expect(
      resolveWindowState(
        { bounds: { x: 7000, y: 7000, width: 4000, height: 200 }, maximized: false },
        [primary, left],
      ),
    ).toEqual({ bounds: { x: 0, y: 230, width: 1920, height: 620 }, maximized: false });
  });

  it("uses safe default dimensions when there is no saved state", () => {
    expect(resolveWindowState(null, [primary])).toEqual({
      bounds: { width: 1100, height: 780 },
      maximized: false,
    });
  });

  it("bounds native unread counts", () => {
    expect(normalizeUnreadCount(-4)).toBe(0);
    expect(normalizeUnreadCount(3.9)).toBe(3);
    expect(normalizeUnreadCount(10_000)).toBe(999);
    expect(normalizeUnreadCount("3")).toBe(0);
  });
});
