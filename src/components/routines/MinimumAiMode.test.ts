import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MinimumAiMode } from "./MinimumAiMode";
it("shows the selector and explains the safety behavior", () => {
  const html = renderToStaticMarkup(createElement(MinimumAiMode, { enabled: true, onChange: vi.fn() }));
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain("Minimum AI");
  expect(html).toContain("stop on errors");
});
