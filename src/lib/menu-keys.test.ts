import { describe, expect, it } from "vitest";
import { isTypeaheadKey, TYPEAHEAD_RESET_MS, typeaheadMatch, typeaheadText } from "./menu-keys";

const rows = ["Sonnet 5", "Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Show all 8 models"];

describe("typing to jump to a menu row", () => {
  it("builds a word from quick keystrokes and starts over after a pause", () => {
    const first = typeaheadText(null, "o", 1_000);
    const second = typeaheadText(first, "p", 1_000 + TYPEAHEAD_RESET_MS - 1);
    expect(second.text).toBe("op");
    expect(typeaheadText(second, "f", second.at + TYPEAHEAD_RESET_MS).text).toBe("f");
  });

  it("finds the next row that starts with the typed word, from the focused one and wrapping", () => {
    expect(typeaheadMatch(rows, 0, "op")).toBe(3);
    expect(typeaheadMatch(rows, 4, "opus 5.5")).toBe(3);
    expect(typeaheadMatch(rows, 0, "x")).toBeNull();
  });

  it("cycles through the rows that start with one letter typed again and again", () => {
    expect(typeaheadMatch(rows, 0, "f")).toBe(1);
    expect(typeaheadMatch(rows, 1, "ff")).toBe(2);
    expect(typeaheadMatch(rows, 2, "fff")).toBe(1);
    expect(typeaheadMatch(rows, 5, "s")).toBe(0);
    expect(typeaheadMatch(rows, -1, "s")).toBe(0);
  });

  it("takes printable keys only, never a shortcut or Space, which presses the focused row", () => {
    const key = (value: string, modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
      isTypeaheadKey({ key: value, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });
    expect(key("o")).toBe(true);
    expect(key("5")).toBe(true);
    expect(key(" ")).toBe(false);
    expect(key("ArrowDown")).toBe(false);
    expect(key("k", { metaKey: true })).toBe(false);
  });
});
