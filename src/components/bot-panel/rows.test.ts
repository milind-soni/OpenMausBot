import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NavRow } from "./rows";

const classes = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, "g"))][0]?.[1].split(" ") ?? [];

it("keeps room for the title on a phone and lets a long value shrink instead", () => {
  const html = renderToStaticMarkup(createElement(NavRow, { title: "Apps it can use", value: "google-calendar, gmail, notion, slack, linear, github", onClick: () => {} }));
  expect(classes(html, "div")).toContain("min-w-[45%]");
  expect(classes(html, "span")).toContain("min-w-0");
  expect(classes(html, "span")).not.toContain("shrink-0");
});

it("puts the ellipsis on the value text itself, so it also shows in Firefox", () => {
  const html = renderToStaticMarkup(createElement(NavRow, { title: "Apps it can use", value: "google-calendar, gmail, notion, slack, linear, github", onClick: () => {} }));
  expect(html).toMatch(/<span class="truncate">google-calendar, gmail, notion, slack, linear, github<\/span>/);
});
