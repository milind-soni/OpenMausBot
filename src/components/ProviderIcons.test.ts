import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

describe("ProviderMark theme visibility", () => {
  it.each(["cursorAgent", "hermesAgent"])("renders %s with the active theme ink color", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind }));

    expect(markup).toContain("var(--color-ink)");
    expect(markup).not.toContain("#F5F5F5");
  });
});
