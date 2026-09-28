import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GroupUsageChip } from "./GroupUsageChip";

it("separates output from input in both the chip and the latest speaker detail", () => {
  const html = renderToStaticMarkup(createElement(GroupUsageChip, { usage: {
    input: 100, cachedInput: 80, output: 10, turns: 1, costUsd: null,
    lastTurn: { input: 100, cachedInput: 80, output: 10, costUsd: null }, lastSpeaker: { botId: "one", name: "One" },
  } }));
  expect(html).toContain("20 uncached input · 80 cached input · 10 output");
  expect(html).toContain("Last turn · One");
  expect(html).toContain(">20 uncached input</span>");
});

it("does not invent cache values and hides an unused thread", () => {
  const html = renderToStaticMarkup(createElement(GroupUsageChip, { usage: { input: 100, output: 10, turns: 1, costUsd: null } }));
  expect(html).toContain("100 input (cache split unknown) · 10 output");
  expect(html).toContain(">100 input</span>");
  expect(html).not.toContain("0 cached");
  expect(renderToStaticMarkup(createElement(GroupUsageChip, {}))).toBe("");
});
