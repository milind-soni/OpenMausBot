import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MinimumAiReview } from "./MinimumAiReview";

it("offers a paused review before any workflow is built or tested", () => {
  const request = vi.fn();
  const html = renderToStaticMarkup(createElement(MinimumAiReview, { routineId: "routine-1", request, onDone: vi.fn(), onClose: vi.fn() }));
  expect(html).toContain("Build workflow");
  expect(html).toContain("paused");
  expect(html).toContain("Record with bot");
  expect(html).toContain("this first run performs the task");
  expect(request).not.toHaveBeenCalled();
});
