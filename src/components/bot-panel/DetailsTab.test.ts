import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemRow } from "./DetailsTab";

const spans = (markup: string) => [...markup.matchAll(/<span class="([^"]*)"/g)].map((match) => match[1].split(" "));

describe("Details tab item row", () => {
  // A long usage value ("143k uncached · 62% context used") used to keep its full width and squeeze the label to "U".
  it("lets a long trailing value wrap in the space the label leaves instead of crushing the label", () => {
    const markup = renderToStaticMarkup(createElement(ItemRow, {
      item: { key: "usage", label: "Usage", icon: null, onSelect: () => undefined, trailing: createElement("span", null, "143k uncached · 62% context used") },
    }));
    const [, label, trailing] = spans(markup);
    expect(label).toContain("truncate");
    expect(label).not.toContain("flex-1");
    expect(trailing).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "justify-end", "text-end"]));
    expect(trailing).not.toContain("shrink-0");
  });

  it("keeps a shortcut at its full width and lets the label truncate instead", () => {
    const markup = renderToStaticMarkup(createElement(ItemRow, {
      item: { key: "find", label: "Find in conversation", icon: null, onSelect: () => undefined, trailing: createElement("kbd", null, "Ctrl F") },
    }));
    const [, label, trailing] = spans(markup);
    expect(label).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "truncate"]));
    expect(trailing).toContain("shrink-0");
    expect(trailing).not.toContain("flex-1");
  });
});
