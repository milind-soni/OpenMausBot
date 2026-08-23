import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeepSeekHarnessMark, ProviderMark } from "./ProviderIcons";

const FISH_GEOMETRY_PREFIX = "M22.9168 1.43018C22.6713 1.31018";

describe("DeepSeek Harness provider mark", () => {
  it("renders the official fish geometry in DeepSeek blue with currentColor", () => {
    const markup = renderToStaticMarkup(createElement(DeepSeekHarnessMark, { size: 24 }));

    expect(markup).toContain('viewBox="0 0 23.16 17.04"');
    expect(markup).toContain(FISH_GEOMETRY_PREFIX);
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('color:#4D6BFE');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<title");
  });

  it("uses the fish at compact provider-rail sizes", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, {
      driverKind: "deepseekHarness",
      size: 14,
      className: "provider-mark",
    }));

    expect(markup).toContain('width="14"');
    expect(markup).toMatch(/height="10\.3005\d+"/);
    expect(markup).toContain("provider-mark");
    expect(markup).toContain(FISH_GEOMETRY_PREFIX);
  });
});
