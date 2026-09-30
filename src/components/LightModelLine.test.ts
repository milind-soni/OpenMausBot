import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LightModelLine } from "./LightModelLine";

describe("light model line", () => {
  it("says the reply ran on the lighter model, with the model and certainty on hover", () => {
    const html = renderToStaticMarkup(createElement(LightModelLine, { routedBy: { provider: "jev", probability: 0.914, model: "claude-haiku-4-5" } }));
    expect(html).toContain("Light model · easy message");
    expect(html).toContain("91% sure");
    expect(html).toContain("claude-haiku-4-5");
  });
});
