import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WIDGET_SAMPLES } from "../../../shared/widget-samples";
import { parseWidgetInput } from "../../../shared/widget";
import { WidgetChart } from "./WidgetChart";

describe("WidgetChart", () => {
  it("holds the chart's space under a name a screen reader can read, and draws nothing for a chart with no rows or no series", () => {
    const parsed = parseWidgetInput(WIDGET_SAMPLES.tokenChart);
    if (!parsed.ok) throw new Error(parsed.error);
    const markup = renderToStaticMarkup(createElement(WidgetChart, { node: parsed.value.children![0]! }));
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Chart of Opus, Sonnet across 7 points"');
    expect(markup).toContain("height:184px");
    expect(renderToStaticMarkup(createElement(WidgetChart, { node: { type: "Chart", id: "n1" } }))).toBe("");
    expect(renderToStaticMarkup(createElement(WidgetChart, { node: { type: "Chart", id: "n1", data: [{ day: "Mon", a: 1 }], series: [] } }))).toBe("");
  });
});
