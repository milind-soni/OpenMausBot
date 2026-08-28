import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_DENSITY_KEY,
  loadCollapsedSections,
  loadSidebarDensity,
  parseSidebarDensity,
  saveCollapsedSections,
  saveSidebarDensity,
  toggleCollapsedSection,
} from "./sidebar-preferences";

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

  it("persists collapsed section ids", () => {
    const setItem = vi.fn();
    saveCollapsedSections(["channels", "Agents"], { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_KEY, "channels\nAgents");
    expect(loadCollapsedSections({ getItem: () => "Strategy" })).toEqual(["Strategy"]);
    expect(toggleCollapsedSection(["Agents"], "channels")).toEqual(["Agents", "channels"]);
    expect(toggleCollapsedSection(["channels"], "channels")).toEqual([]);
  });
});
