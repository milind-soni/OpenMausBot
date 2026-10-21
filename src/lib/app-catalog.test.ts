import { describe, expect, it } from "vitest";
import { CATEGORY_SECTION_SIZE, catalogSections, inCategory, rankCategories, withSciencePill } from "./app-catalog";

const card = (slug: string, ...categories: string[]) => ({ slug, categories });

describe("rankCategories", () => {
  it("ranks by how many apps carry a category, ties by name, and folds the rest under More", () => {
    const cards = [card("a", "Productivity", "Files"), card("b", "Productivity"), card("c", "Design"), card("d", "Communication", "Communication"), card("e"), { slug: "f" }];
    expect(rankCategories(cards, 2)).toEqual({ inline: ["Productivity", "Communication"], more: ["Design", "Files"] });
    expect(rankCategories([])).toEqual({ inline: [], more: [] });
  });
});

describe("inCategory", () => {
  it("lets everything through without a category", () => {
    expect(inCategory({ slug: "x" }, null)).toBe(true);
    expect(inCategory(card("x", "Design"), "Design")).toBe(true);
    expect(inCategory({ slug: "x" }, "Design")).toBe(false);
  });
});

describe("catalogSections", () => {
  const cards = [
    card("slack", "Communication"),
    card("gmail", "Communication"),
    ...Array.from({ length: 6 }, (_, index) => card(`p${index}`, "Productivity")),
    card("figma", "Design"),
  ];
  const connected = (slug: string) => slug === "slack";

  it("leads with connected apps, previews categories with what is left, then the whole catalog", () => {
    const sections = catalogSections(cards, connected, ["Productivity", "Communication", "Design", "Files"]);
    expect(sections.map((section) => section.kind === "category" ? section.category : section.kind)).toEqual(["connected", "Productivity", "Communication", "Design", "all"]);
    expect(sections[0]!.cards.map((entry) => entry.slug)).toEqual(["slack"]);
    const productivity = sections[1]!;
    expect(productivity.cards).toHaveLength(CATEGORY_SECTION_SIZE);
    expect(productivity.kind === "category" && productivity.more).toBe(true);
    expect(sections[2]!.cards.map((entry) => entry.slug)).toEqual(["gmail"]);
    expect(sections.at(-1)!.cards.some((entry) => entry.slug === "slack")).toBe(false);
  });

  it("keeps the catalog section even when empty, and skips empty ones", () => {
    expect(catalogSections([], connected, ["Design"])).toEqual([{ kind: "all", cards: [] }]);
  });
});

describe("withSciencePill", () => {
  const row = ["Productivity", "Developer tools", "Communication", "Files", "Sales and CRM"];
  it("Science takes Files' place in the row", () => {
    expect(withSciencePill({ inline: row, more: ["Social", "Analytics"] }))
      .toEqual({ inline: ["Productivity", "Developer tools", "Communication", "Sales and CRM"], more: ["Files", "Social", "Analytics"] });
  });
  it("moves the last inline category into More when Files is not inline, matching exactly", () => {
    const inline = ["Productivity", "Developer tools", "Communication", "files", "Sales and CRM"];
    expect(withSciencePill({ inline, more: ["Files"] }))
      .toEqual({ inline: inline.slice(0, 4), more: ["Sales and CRM", "Files"] });
  });
  it("leaves an empty row alone", () => {
    expect(withSciencePill({ inline: [], more: [] })).toEqual({ inline: [], more: [] });
  });
});
