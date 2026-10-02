import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveReasoning } from "./LiveReasoning";

describe("live provider reasoning", () => {
  it("does not offer an empty disclosure", () => {
    expect(renderToStaticMarkup(createElement(LiveReasoning, { text: " \n " }))).toBe("");
  });
  it("renders untrusted reasoning as text and keeps long streams bounded to their recent tail", () => {
    const markup = renderToStaticMarkup(createElement(LiveReasoning, { text: "discarded prefix" + "a".repeat(12000) + "<script>alert(1)</script>" }));
    expect(markup).not.toContain("discarded prefix");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain('aria-live="off"');
  });
});
