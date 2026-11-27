import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONVERSATION_ITEMS, ItemRow } from "./DetailsTab";

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
    expect(trailing).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "justify-end", "text-right"]));
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

  it("lists Set as main thread under This conversation as an action, with no chevron, its hint as the tooltip when off", () => {
    expect(CONVERSATION_ITEMS.slice(0, 3)).toEqual(["find", "start-fresh", "set-main"]);
    const markup = renderToStaticMarkup(createElement(ItemRow, {
      item: { key: "set-main", label: "Set as main thread", icon: null, disabled: true, title: "This is already the main thread", onSelect: () => undefined },
    }));
    expect(markup).toContain('title="This is already the main thread"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("lucide-chevron-right");
  });
});
