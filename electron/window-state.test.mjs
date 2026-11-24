import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { minimumWindowBounds, normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

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

  it.each([
    ["desktop", {}, 620],
    ["Hyprland", { XDG_CURRENT_DESKTOP: "Hyprland", HYPRLAND_INSTANCE_SIGNATURE: "fixture" }, 480],
  ])("centers an off-screen window and clamps its height to the %s minimum", (_session, env, height) => {
    expect(
      resolveWindowState(
        { bounds: { x: 7000, y: 7000, width: 4000, height: 200 }, maximized: false },
        [primary, left],
        undefined,
        minimumWindowBounds("linux", env),
      ),
    ).toEqual({ bounds: { x: 0, y: (primary.height - height) / 2, width: 1920, height }, maximized: false });
  });

  it("uses safe default dimensions when there is no saved state", () => {
    expect(resolveWindowState(null, [primary])).toEqual({
      bounds: { width: 1040, height: 760 },
      maximized: false,
    });
  });

  it("reopens a narrow Hyprland tile at its saved size", () => {
    const env = { XDG_CURRENT_DESKTOP: "Hyprland", HYPRLAND_INSTANCE_SIGNATURE: "fixture" };
    const minimum = minimumWindowBounds("linux", env);
    const bounds = { x: 20, y: 20, width: 480, height: 540 };
    expect(resolveWindowState({ bounds }, [primary], undefined, minimum).bounds).toEqual(bounds);
    expect(minimumWindowBounds("linux", {})).toEqual({ width: 840, height: 620 });
    expect(minimumWindowBounds("win32", env)).toEqual({ width: 840, height: 620 });
  });

  it("bounds native unread counts", () => {
    expect(normalizeUnreadCount(-4)).toBe(0);
    expect(normalizeUnreadCount(3.9)).toBe(3);
    expect(normalizeUnreadCount(10_000)).toBe(999);
    expect(normalizeUnreadCount("3")).toBe(0);
  });
});
