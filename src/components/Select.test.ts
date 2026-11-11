import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select } from "./Select";

describe("Select", () => {
  it("opens its list in the skin's light or dark scheme, so options stay readable in dark mode", () => {
    const html = renderToStaticMarkup(createElement(Select, { "aria-label": "Effort", defaultValue: "low" },
      createElement("option", { value: "low" }, "Low"), createElement("option", { value: "high" }, "High")));
    const select = (/<select[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").replaceAll("&amp;", "&");
    expect(select.split(/\s+/)).toEqual(expect.arrayContaining(["[color-scheme:var(--code-color-scheme)]", "[&_option]:bg-menu", "[&_option]:text-ink"]));
  });
});
