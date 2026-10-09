import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ComposerMenuRow } from "./ComposerMenuRow";

it("keeps the description on its own direction and the kind tag at the logical end", () => {
  const props = {
    icon: createElement("span", null, "icon"),
    name: "Atlas",
    description: "مسؤول الهجرة",
    kind: "Agent",
    selected: true,
    id: "composer-mention-atlas",
    role: "option",
    "aria-selected": true,
    "data-mention-index": 0,
  } as ComponentProps<typeof ComposerMenuRow>;
  const html = renderToStaticMarkup(createElement(ComposerMenuRow, props));
  expect(html).toContain('dir="auto"');
  expect(html).toContain("مسؤول الهجرة");
  expect(html).toContain("Agent");
  expect(html).toContain('id="composer-mention-atlas"');
  expect(html).toContain('role="option"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('data-mention-index="0"');
  expect(html).toContain("text-start");
  expect(html).toContain("text-end");
  expect(html).not.toContain("text-left");
  expect(html).not.toContain("text-right");
  expect(html).toContain("truncate");
  expect(html).toContain("bg-raised-hover");
});

it("omits the description line when a bot has no title", () => {
  const html = renderToStaticMarkup(createElement(ComposerMenuRow, {
    icon: null,
    name: "everyone",
    kind: "Group chat",
  }));
  expect(html).not.toContain('dir="auto"');
  expect(html).toContain("everyone");
  expect(html).toContain("Group chat");
});
