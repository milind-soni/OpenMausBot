import { describe, expect, it } from "vitest";
import { dueDatePresets, filterCommands, filterShortcuts, shortcutLabels, suggestLabels } from "./command-menu";

describe("command menu", () => {
  const commands = [{ label: "Assign to…" }, { label: "Change status…", keywords: "state column" }, { label: "Change priority…" }, { label: "Copy issue URL", keywords: "link" }];
  it("matches every word and ranks labels that start with the query first", () => {
    expect(filterCommands(commands, "").length).toBe(4);
    expect(filterCommands(commands, "change").map(item => item.label)).toEqual(["Change status…", "Change priority…"]);
    expect(filterCommands(commands, "link").map(item => item.label)).toEqual(["Copy issue URL"]);
    expect(filterCommands(commands, "column change").map(item => item.label)).toEqual(["Change status…"]);
    expect(filterCommands(commands, "s").map(item => item.label)[0]).toBe("Assign to…");
  });
  it("shows platform keys", () => {
    expect(shortcutLabels(["Mod", "K"], true)).toEqual(["⌘", "K"]);
    expect(shortcutLabels(["Mod", "Shift", "."], false)).toEqual(["Ctrl", "Shift", "."]);
  });
  it("searches the shortcut reference by label, group or key", () => {
    expect(filterShortcuts("status").map(entry => entry.label)).toEqual(["Change status"]);
    expect(filterShortcuts("views").map(entry => entry.label)).toEqual(["Board layout", "List layout"]);
    expect(filterShortcuts("").length).toBeGreaterThan(10);
  });
  it("offers due dates in local time", () => {
    const presets = dueDatePresets(new Date(2026, 10, 11));
    expect(presets.map(preset => preset.value)).toEqual(["2026-11-11", "2026-11-12", "2026-11-16", "2026-11-25"]);
  });
});

describe("label suggestions", () => {
  it("suggests Feature, Bug or Improvement from the title", () => {
    expect(suggestLabels("Fix stale issue counts")).toEqual(["Bug"]);
    expect(suggestLabels("Add saved filters")).toEqual(["Feature"]);
    expect(suggestLabels("Improve empty project states")).toEqual(["Improvement"]);
    expect(suggestLabels("Add saved filters", ["feature"])).toEqual([]);
    expect(suggestLabels("Quarterly planning")).toEqual([]);
  });
});
