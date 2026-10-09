import { describe, expect, it, vi } from "vitest";

import {
  PINNED_CIRCLES_KEY,
  SIDEBAR_ATTENTION_PINNED_KEY,
  UNIVERSAL_PINS_KEY,
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_TOOLS_LAYOUT_KEY,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  clampSidebarWidth,
  loadPinnedCircles,
  loadUniversalPins,
  loadSidebarAttentionPinned,
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarDensity,
  loadSidebarToolsLayout,
  loadSidebarWidth,
  parsePinnedCircles,
  parseUniversalPins,
  parseSidebarAttentionPinned,
  parseSidebarDensity,
  parseSidebarToolsLayout,
  saveCollapsedSections,
  savePinnedCircles,
  saveUniversalPins,
  saveSectionOrder,
  saveSidebarAttentionPinned,
  saveSidebarDensity,
  saveSidebarToolsLayout,
  saveSidebarWidth,
  setSidebarToolsLayout,
  subscribeSidebarToolsLayout,
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

describe("sidebar width preference", () => {
  it("keeps the chat usable and rejects invalid saved widths", () => {
    expect(clampSidebarWidth(500, 900)).toBe(480);
    expect(clampSidebarWidth(500, 768)).toBe(448);
    expect(clampSidebarWidth(100, 900)).toBe(240);
    expect(loadSidebarWidth({ getItem: () => "360" })).toBe(360);
    for (const raw of ["NaN", "9999", "-1", "320.5"]) {
      expect(loadSidebarWidth({ getItem: () => raw })).toBeNull();
    }
  });

  it("persists width without requiring local storage", () => {
    const setItem = vi.fn();
    saveSidebarWidth(360, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_KEY, "360");
    expect(loadSidebarWidth({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(() => saveSidebarWidth(360, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
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

describe("pinned circles preference", () => {
  it("defaults off, stores the exact flag, and survives blocked storage", () => {
    expect(parsePinnedCircles("true")).toBe(true);
    expect(parsePinnedCircles("false")).toBe(false);
    expect(parsePinnedCircles("yes")).toBe(false);
    expect(parsePinnedCircles("1")).toBe(false);
    expect(parsePinnedCircles(null)).toBe(false);

    const setItem = vi.fn();
    savePinnedCircles(true, { setItem });
    savePinnedCircles(false, { setItem });
    expect(setItem).toHaveBeenNthCalledWith(1, PINNED_CIRCLES_KEY, "true");
    expect(setItem).toHaveBeenNthCalledWith(2, PINNED_CIRCLES_KEY, "false");
    expect(loadPinnedCircles({ getItem: () => "true" })).toBe(true);
    expect(loadPinnedCircles({ getItem: () => "false" })).toBe(false);
    expect(loadPinnedCircles({ getItem: () => "untrusted" })).toBe(false);
    expect(loadPinnedCircles({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
    expect(loadPinnedCircles(null)).toBe(false);
    expect(() => savePinnedCircles(true, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(() => savePinnedCircles(true, null)).not.toThrow();
  });
});

describe("universal pins preference", () => {
  it("defaults off, stores the exact flag, and survives blocked storage", () => {
    expect(parseUniversalPins("true")).toBe(true);
    expect(parseUniversalPins("false")).toBe(false);
    expect(parseUniversalPins("yes")).toBe(false);
    expect(parseUniversalPins(null)).toBe(false);

    const setItem = vi.fn();
    saveUniversalPins(true, { setItem });
    saveUniversalPins(false, { setItem });
    expect(setItem).toHaveBeenNthCalledWith(1, UNIVERSAL_PINS_KEY, "true");
    expect(setItem).toHaveBeenNthCalledWith(2, UNIVERSAL_PINS_KEY, "false");
    expect(loadUniversalPins({ getItem: () => "true" })).toBe(true);
    expect(loadUniversalPins({ getItem: () => "false" })).toBe(false);
    expect(loadUniversalPins({ getItem: () => "untrusted" })).toBe(false);
    expect(loadUniversalPins({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
    expect(loadUniversalPins(null)).toBe(false);
    expect(() => saveUniversalPins(true, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(() => saveUniversalPins(true, null)).not.toThrow();
  });
});


describe("sidebar attention pin preference", () => {
  it("round-trips the pinned flag and defaults to the popover", () => {
    expect(parseSidebarAttentionPinned("true")).toBe(true);
    expect(parseSidebarAttentionPinned("false")).toBe(false);
    expect(parseSidebarAttentionPinned("yes")).toBe(false);
    expect(parseSidebarAttentionPinned(null)).toBe(false);

    const setItem = vi.fn();
    saveSidebarAttentionPinned(true, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_ATTENTION_PINNED_KEY, "true");
    expect(loadSidebarAttentionPinned({ getItem: () => "true" })).toBe(true);
    expect(loadSidebarAttentionPinned({ getItem: () => "untrusted" })).toBe(false);
    expect(loadSidebarAttentionPinned({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("sidebar tools layout preference", () => {
  it("tools layout defaults to rows and ignores malformed values", () => {
    expect(parseSidebarToolsLayout("rows")).toBe("rows");
    expect(parseSidebarToolsLayout("toolbar")).toBe("toolbar");
    expect(parseSidebarToolsLayout("icons")).toBe("rows");
    expect(parseSidebarToolsLayout("")).toBe("rows");
    expect(parseSidebarToolsLayout(null)).toBe("rows");
    expect(loadSidebarToolsLayout({ getItem: () => null })).toBe("rows");
    expect(loadSidebarToolsLayout({ getItem: () => "menu" })).toBe("rows");
    expect(loadSidebarToolsLayout({ getItem: () => { throw new Error("blocked"); } })).toBe("rows");

    const setItem = vi.fn();
    saveSidebarToolsLayout("toolbar", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_TOOLS_LAYOUT_KEY, "toolbar");
    expect(loadSidebarToolsLayout({ getItem: (key) => (key === SIDEBAR_TOOLS_LAYOUT_KEY ? "toolbar" : null) })).toBe("toolbar");
  });

  it("setSidebarToolsLayout notifies subscribers and persists", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarToolsLayout(listener);
    try {
      setSidebarToolsLayout("toolbar");
      expect(listener).toHaveBeenCalledOnce();
      expect(values.get(SIDEBAR_TOOLS_LAYOUT_KEY)).toBe("toolbar");
      expect(loadSidebarToolsLayout()).toBe("toolbar");
      setSidebarToolsLayout("rows");
      expect(listener).toHaveBeenCalledTimes(2);
      expect(values.get(SIDEBAR_TOOLS_LAYOUT_KEY)).toBe("rows");
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });
});
