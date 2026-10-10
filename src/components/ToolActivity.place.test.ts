import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolActivity } from "./ToolActivity";

describe("tool chip place icon", () => {
  it("shows the place a screen or page tool ran on, and nothing for other tools", () => {
    const browser = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "agent_browser_click", ok: true }, place: "browser" }));
    expect(browser).toContain('data-testid="tool-place"');
    expect(browser).toContain('aria-label="Browser"');
    const cloud = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "screenshot", ok: true }, place: "cloud" }));
    expect(cloud).toContain('aria-label="Cloud computer"');
    const shell = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true } }));
    expect(shell).not.toContain('data-testid="tool-place"');
  });
});
