import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  PINNED_CIRCLES_KEY,
  PINNED_CIRCLE_ORDER_KEY,
  SIDEBAR_ATTENTION_PINNED_KEY,
  UNIVERSAL_PINS_KEY,
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIMPLE_SIDEBAR_SECTION_ORDER_KEY,
  SIMPLE_SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadPinnedCircles,
  loadPinnedCircleOrder,
  loadUniversalPins,
  loadSidebarAttentionPinned,
  loadCollapsedSections,
  loadSimpleSectionOrder,
  loadSidebarDensity,
  loadSidebarWidth,
  parsePinnedCircles,
  parseUniversalPins,
  parseSidebarAttentionPinned,
  parseSidebarDensity,
  saveCollapsedSections,
  savePinnedCircles,
  setPinnedCircleOrder,
  saveUniversalPins,
  saveSimpleSectionOrder,
  saveSidebarAttentionPinned,
  saveSidebarDensity,
  saveSidebarWidth,
  toggleCollapsedSection,
  usePinnedCircleOrder,
} from "./sidebar-preferences";
import { userSectionId } from "./sidebar-layout";

describe("sidebar density preferences", () => {
  it("keeps the column of avatars the sidebar was dragged to; every other value, an older app's included, opens it", () => {
    expect(parseSidebarDensity("avatars")).toBe("icons");
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact"), "Settings' compact density, gone").toBe("comfortable");
    expect(parseSidebarDensity("icons"), "Settings' avatars only, gone: the person drags instead").toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "avatars");
    saveSidebarDensity("comfortable", { setItem });
    expect(setItem).toHaveBeenLastCalledWith(SIDEBAR_DENSITY_KEY, "comfortable");
    expect(loadSidebarDensity({ getItem: () => "avatars" })).toBe("icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("comfortable");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("sidebar width preference", () => {
  it("keeps the chat usable and rejects invalid saved widths", () => {
    expect(clampSidebarWidth(500, 900)).toBe(480);
    expect(clampSidebarWidth(500, 768)).toBe(448);
    expect(clampSidebarWidth(100, 900)).toBe(280);
    expect(loadSidebarWidth({ getItem: () => "360" })).toBe(360);
    for (const raw of ["NaN", "9999", "-1", "270", "320.5"]) {
      expect(loadSidebarWidth({ getItem: () => raw })).toBeNull();
    }
  });

  it("persists width without requiring local storage", () => {
    const setItem = vi.fn();
    saveSidebarWidth(360, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIMPLE_SIDEBAR_WIDTH_KEY, "360");
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
    saveSimpleSectionOrder(["section:Work", "builtin:bots"], { setItem: orderSet });
    expect(orderSet).toHaveBeenCalledWith(
      SIMPLE_SIDEBAR_SECTION_ORDER_KEY,
      JSON.stringify(["section:Work", "builtin:bots"]),
    );
    expect(loadSimpleSectionOrder({ getItem: () => JSON.stringify(["section:Work", "builtin:bots"]) })).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
  });

  it("uses the old Advanced section order until the unified order is saved", () => {
    const legacy = JSON.stringify(["section:Work", "builtin:bots"]);
    let unified: string | null = null;
    const storage = {
      getItem: (key: string) => key === "openmausbot.sidebarSectionOrder.v1" ? legacy : unified,
      setItem: (_key: string, value: string) => { unified = value; },
    };

    expect(loadSimpleSectionOrder(storage)).toEqual(["section:Work", "builtin:bots"]);
    saveSimpleSectionOrder(["builtin:bots", "section:Work"], storage);
    expect(loadSimpleSectionOrder(storage)).toEqual(["builtin:bots", "section:Work"]);
  });

  it("ignores malformed storage and toggles ids without mutating the source", () => {
    expect(loadCollapsedSections({ getItem: () => "not-json" })).toEqual([]);
    expect(loadSimpleSectionOrder({ getItem: () => JSON.stringify({ nope: true }) })).toEqual([]);
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
    expect(loadSimpleSectionOrder({ getItem: () => JSON.stringify([withNewline]) })).toEqual([withNewline]);

    const oversized = Array.from({ length: 105 }, (_, index) => `section:${index}`);
    expect(loadSimpleSectionOrder({ getItem: () => JSON.stringify(oversized) })).toHaveLength(100);
    expect(loadSimpleSectionOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(() => saveSimpleSectionOrder(["section:Work"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("persists raw section ids with lone surrogates and max-length emoji names", () => {
    const ids = [userSectionId("\ud800"), userSectionId("🧠".repeat(30))];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    saveSimpleSectionOrder(ids, storage);
    expect(loadSimpleSectionOrder(storage)).toEqual(ids);
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

describe("pinned circle order", () => {
  it("keeps one deduplicated order, ignores a malformed list, and keeps the order for the session when storage is blocked", () => {
    const setItem = vi.fn();
    setPinnedCircleOrder(["b", "a", "a"], { setItem });
    expect(setItem).toHaveBeenCalledWith(PINNED_CIRCLE_ORDER_KEY, JSON.stringify(["b", "a"]));
    expect(loadPinnedCircleOrder({ getItem: () => JSON.stringify(["b", "a"]) })).toEqual(["b", "a"]);
    expect(loadPinnedCircleOrder({ getItem: () => "nope" })).toEqual([]);
    expect(loadPinnedCircleOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(() => setPinnedCircleOrder(["c", "b"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
    function Probe() { return createElement("i", null, usePinnedCircleOrder().join(",")); }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>c,b</i>");
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
