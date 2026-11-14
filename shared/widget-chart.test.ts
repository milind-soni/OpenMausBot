// A widget's chart is a Vega-Lite spec drawn with the shared config. These
// render it headless, as the server renders the Data panel's charts, and read
// what Vega drew.
import { None, logger, parse, View } from "vega";
import { compile, type Config, type TopLevelSpec } from "vega-lite";
import { describe, expect, it } from "vitest";

import { VEGA_CATEGORY_RANGE, vegaConfig } from "./vega-config.ts";
import { parseWidgetInput, type WidgetNode } from "./widget.ts";
import { widgetChartHeight, widgetChartSpec } from "./widget-chart.ts";
import { WIDGET_SAMPLES } from "./widget-samples.ts";

const data = [
  { day: "Mon", a: 4, b: 1 }, { day: "Tue", a: 6, b: 2 }, { day: "Wed", a: 9, b: 3 }, { day: "Thu", a: 5, b: 0 }, { day: "Fri", a: 2, b: 4 },
];

/** A canonical Chart node, by way of the normaliser a bot's input goes through. */
function chart(props: Record<string, unknown>, root: Record<string, unknown> = { type: "Card", children: [{ type: "Chart", xAxis: "day", data, ...props }] }): WidgetNode {
  const parsed = parseWidgetInput(root);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.children![0]!;
}

const two = (type: string, more: Record<string, unknown> = {}) => chart({ series: [{ type, dataKey: "a", label: "Alpha", ...more }, { type, dataKey: "b", label: "Beta", ...more }] });

interface Drawn {
  svg: string;
  /** Every bar, placed on the chart: its tip and its edges. */
  bars: Array<{ tip: string; x: number; top: number; bottom: number }>;
}

type Scene = { marktype?: string; role?: string; items?: Array<Record<string, unknown> & { items?: Scene[] }> };

async function draw(node: WidgetNode, width = 400): Promise<Drawn> {
  const spec = { ...widgetChartSpec(node, width)!, width };
  const silent = logger(None);
  const { spec: runtime } = compile(spec as unknown as TopLevelSpec, { config: vegaConfig("dark") as Config, logger: silent });
  const view = new View(parse(runtime), { renderer: "none" }).logger(silent);
  try {
    const svg = await view.toSVG();
    const bars: Drawn["bars"] = [];
    const visit = (mark: Scene, dx: number, dy: number) => {
      for (const item of mark.items ?? []) {
        const [x, y] = [dx + Number(item.x ?? 0), dy + Number(item.y ?? 0)];
        if (mark.marktype === "rect" && mark.role === "mark") bars.push({ tip: String((item.datum as { tip: string }).tip), x, top: y, bottom: y + Number(item.height) });
        if (mark.marktype === "group") for (const child of item.items ?? []) visit(child, x, y);
      }
    };
    visit((view.scenegraph() as unknown as { root: Scene }).root, 0, 0);
    return { svg, bars };
  } finally {
    view.finalize();
  }
}

const count = (markup: string, piece: string) => markup.split(piece).length - 1;
const marks = (markup: string, role: string) => count(markup, `aria-roledescription="${role}"`);

describe("widgetChartSpec", () => {
  it.each([["bar", 10, 0, 0], ["line", 0, 2, 10], ["area", 0, 2, 10]])("draws one mark per value of every series for %s", async (type, bars, lines, points) => {
    const { svg } = await draw(two(type));
    expect(marks(svg, "bar")).toBe(bars);
    expect(marks(svg, "line mark")).toBe(lines);
    expect(marks(svg, "point")).toBe(points);
    expect(marks(svg, "area mark")).toBe(type === "area" ? 2 : 0);
    // a mark is called by its tip
    expect(svg).toContain('aria-label="Wed · Alpha: 9"');
  });

  it("puts bars that share a stack in one column, the first series at the foot, and the others side by side", async () => {
    const mon = (drawn: Drawn) => ["Mon · Alpha: 4", "Mon · Beta: 1"].map((tip) => drawn.bars.find((bar) => bar.tip === tip)!);
    const [alpha, beta] = mon(await draw(two("bar")));
    expect(alpha!.x).toBeLessThan(beta!.x);
    expect(alpha!.bottom).toBeCloseTo(beta!.bottom);
    const [low, high] = mon(await draw(two("bar", { stack: "all" })));
    expect(low!.x).toBeCloseTo(high!.x);
    expect(high!.bottom).toBeCloseTo(low!.top);
  });

  it("leaves a gap in a line where a row has no value, instead of a mark at zero", async () => {
    const { svg } = await draw(chart({ data: [{ day: "Mon", a: 1 }, { day: "Tue", a: null }, { day: "Wed", a: 3 }, { day: "Thu", a: 2 }], series: [{ type: "line", dataKey: "a" }] }));
    expect(marks(svg, "point")).toBe(3);
    const path = /aria-roledescription="line mark" d="([^"]+)"/.exec(svg)![1]!;
    expect(count(path, "M")).toBe(2);
  });

  it("labels the x axis by row, and draws the y axis, the grid and the legend only when they are on", async () => {
    const plain = (await draw(two("bar"))).svg;
    for (const row of data) expect(plain).toContain(`>${row.day}</text>`);
    expect(count(plain, "role-axis-grid")).toBe(1);
    expect(count(plain, 'aria-roledescription="axis"')).toBe(1);
    expect(plain).toContain(">Beta</text>");

    const node = chart({ series: [{ type: "bar", dataKey: "a", label: "Alpha" }], showYAxis: true, showGrid: false, showLegend: false, height: 200 });
    const dressed = (await draw(node)).svg;
    expect(count(dressed, "role-axis-grid")).toBe(0);
    expect(count(dressed, 'aria-roledescription="axis"')).toBe(2);
    expect(dressed).not.toContain('aria-roledescription="legend"');
    expect(widgetChartSpec(node)!.height).toBe(200);
  });

  it("keeps two rows named alike as two bands, and two series labelled alike in their own colours", async () => {
    const node = chart({ data: [{ day: "Mon", a: 1, b: 2 }, { day: "Mon", a: 3, b: 4 }], series: [{ type: "bar", dataKey: "a", label: "Same" }, { type: "bar", dataKey: "b", label: "Same" }] });
    const { svg, bars } = await draw(node);
    expect(new Set(bars.map((bar) => bar.x)).size).toBe(4);
    expect(svg).toContain(`fill="${VEGA_CATEGORY_RANGE[0]}"`);
    expect(svg).toContain(`fill="${VEGA_CATEGORY_RANGE[1]}"`);
  });

  it("draws the sample's stacked week, sizes by height, then aspect ratio, then 160, and draws nothing with no rows or no series", async () => {
    const parsed = parseWidgetInput(WIDGET_SAMPLES.tokenChart);
    if (!parsed.ok) throw new Error(parsed.error);
    const sample = parsed.value.children![0]!;
    expect((await draw(sample)).bars).toHaveLength(14);
    // 160 for the plot, and a line for the legend
    expect(widgetChartHeight(sample, 560)).toBe(184);
    const single = { series: [{ type: "line", dataKey: "a" }] };
    expect(widgetChartHeight(chart(single), 560)).toBe(160);
    expect(widgetChartHeight(chart({ ...single, aspectRatio: 2 }), 300)).toBe(150);
    expect(widgetChartHeight(chart({ ...single, aspectRatio: 10 }), 300)).toBe(80);
    expect(widgetChartSpec({ type: "Chart", id: "n1" })).toBeNull();
    expect(widgetChartSpec({ type: "Chart", id: "n1", data: [{ day: "Mon", a: 1 }], series: [] })).toBeNull();
  });
});
