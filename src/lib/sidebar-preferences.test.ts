import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_EXPANDED_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  sidebarIsRail,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarDensity,
  parseSidebarDensity,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarDensity,
  toggleCollapsedSection,
} from "./sidebar-preferences";
import { userSectionId } from "./sidebar-layout";

describe("sidebar density preferences", () => {
  it("accepts the three supported layouts and rejects stale values", () => {
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("compact");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("sidebar section preferences", () => {
  it("round-trips unique collapsed and ordered section ids", () => {
    const collapsedSet = vi.fn();
    saveCollapsedSections(["builtin:pinned", "builtin:pinned", "section:Work"], {
      setItem: collapsedSet,
    });
    expect(collapsedSet).toHaveBeenCalledWith(
      SIDEBAR_COLLAPSED_SECTIONS_KEY,
      JSON.stringify(["builtin:pinned", "section:Work"]),
    );
    expect(
      loadCollapsedSections({
        getItem: () => JSON.stringify(["builtin:pinned", "section:Work"]),
      }),
    ).toEqual(["builtin:pinned", "section:Work"]);

    const orderSet = vi.fn();
    saveSectionOrder(["section:Work", "builtin:bots"], { setItem: orderSet });
    expect(orderSet).toHaveBeenCalledWith(
      SIDEBAR_SECTION_ORDER_KEY,
      JSON.stringify(["section:Work", "builtin:bots"]),
    );
    expect(loadSectionOrder({ getItem: () => JSON.stringify(["section:Work", "builtin:bots"]) })).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
  });

  it("ignores malformed storage and toggles ids without mutating the source", () => {
    expect(loadCollapsedSections({ getItem: () => "not-json" })).toEqual([]);
    expect(loadSectionOrder({ getItem: () => JSON.stringify({ nope: true }) })).toEqual([]);
    const current = ["section:Work"];
    expect(toggleCollapsedSection(current, "builtin:bots")).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
    expect(toggleCollapsedSection(current, "section:Work")).toEqual([]);
    expect(current).toEqual(["section:Work"]);
  });

  it("supports newlines, caps untrusted arrays, and tolerates blocked storage", () => {
    const withNewline = "section:Line\nBreak";
    expect(loadSectionOrder({ getItem: () => JSON.stringify([withNewline]) })).toEqual([withNewline]);

    const oversized = Array.from({ length: 105 }, (_, index) => `section:${index}`);
    expect(loadSectionOrder({ getItem: () => JSON.stringify(oversized) })).toHaveLength(100);
    expect(loadSectionOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(() => saveSectionOrder(["section:Work"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("persists raw section ids with lone surrogates and max-length emoji names", () => {
    const ids = [userSectionId("\ud800"), userSectionId("🧠".repeat(30))];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    saveSectionOrder(ids, storage);
    expect(loadSectionOrder(storage)).toEqual(ids);
  });
});

describe("sidebar width preference", () => {
  it("snaps to the rail below the dead zone and clamps at both ends", () => {
    expect(clampSidebarWidth(60)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(clampSidebarWidth(179)).toBe(SIDEBAR_RAIL_WIDTH);
    // the dead zone: no sidebar is ever 200px wide
    expect(clampSidebarWidth(200)).toBe(SIDEBAR_MIN_EXPANDED_WIDTH);
    expect(clampSidebarWidth(9000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(321)).toBe(321);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(sidebarIsRail(SIDEBAR_RAIL_WIDTH)).toBe(true);
    expect(sidebarIsRail(SIDEBAR_MIN_EXPANDED_WIDTH)).toBe(false);
  });

  it("falls back to the saved density instead of resetting the width", () => {
    expect(loadSidebarWidth({ getItem: (key) => (key === SIDEBAR_DENSITY_KEY ? "icons" : null) })).toBe(
      SIDEBAR_RAIL_WIDTH,
    );
    expect(loadSidebarWidth({ getItem: (key) => (key === SIDEBAR_DENSITY_KEY ? "compact" : null) })).toBe(272);
    expect(loadSidebarWidth({ getItem: () => null })).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(loadSidebarWidth({ getItem: () => "288" })).toBe(288);
    expect(loadSidebarWidth({ getItem: () => "garbage" })).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(loadSidebarWidth({ getItem: () => { throw new Error("blocked"); } })).toBe(SIDEBAR_DEFAULT_WIDTH);

    const setItem = vi.fn();
    saveSidebarWidth(300, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_KEY, "300");
  });
});
