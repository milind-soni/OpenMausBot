import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DreamMemoryResult } from "./DreamMemoryCard";

it("shows the time, chats and result counts of the last dream", () => {
  const html = renderToStaticMarkup(createElement(DreamMemoryResult, { report: { at: Date.now(), conversations: 3, learned: [{}], outdated: [{}, {}], ideas: ["idea"], note: "No changes needed." } }));
  expect(html).toContain("3 chats");
  expect(html).toContain("1 learned");
  expect(html).toContain("2 updated");
  expect(html).toContain("1 ideas");
  expect(html).toContain("No changes needed.");
  expect(html).toContain("<time");
});
