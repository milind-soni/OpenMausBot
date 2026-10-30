import { useEffect, useMemo, useRef, useState } from "react";
import type { Result } from "vega-embed";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { vegaConfig } from "../../../shared/vega-config";
import type { WidgetNode } from "../../../shared/widget";
import { WIDGET_CHART_WIDTH, widgetChartHeight, widgetChartSpec } from "../../../shared/widget-chart";
import { boxStyle } from "./widget-style";

export function WidgetChart({ node }: { node: WidgetNode }) {
  const theme = useColorScheme();
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<Result | null>(null);
  const [width, setWidth] = useState(WIDGET_CHART_WIDTH);
  const [failed, setFailed] = useState<string | null>(null);
  const specText = useMemo(() => JSON.stringify(widgetChartSpec(node)), [node]);
  const height = widgetChartHeight(node, width);
  const size = useRef({ width, height });
  size.current = { width, height };

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [specText]);

  useEffect(() => {
    const element = host.current;
    const spec = JSON.parse(specText) as Record<string, unknown> | null;
    if (!element || !spec) return;
    let alive = true;
    setFailed(null);
    void (async () => {
      const { default: embed } = await import("vega-embed");
      if (!alive) return;
      const target = document.createElement("div");
      element.replaceChildren(target);
      const result = await embed(target, { ...spec, ...size.current } as Parameters<typeof embed>[1], { actions: false, ast: true, config: vegaConfig(theme) });
      if (!alive) { result.finalize(); return; }
      drawn.current = result;
    })().catch((cause) => {
      if (alive) setFailed(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive = false;
      drawn.current?.finalize();
      drawn.current = null;
      element.replaceChildren();
    };
  }, [specText, theme]);

  useEffect(() => {
    void drawn.current?.view.width(width).height(height).resize().runAsync().catch(() => undefined);
  }, [width, height]);

  if (specText === "null") return null;
  const series = (node.series as Array<{ label?: string; dataKey: string }>).map((item) => item.label ?? item.dataKey);
  const { height: _height, aspectRatio: _ratio, ...box } = boxStyle(node);
  return (
    <div className="min-w-0" style={box}>
      <div
        ref={host}
        role="img"
        aria-label={t("widget.chart.label", { series: series.join(", "), count: (node.data as unknown[]).length })}
        style={{ height }}
      />
      {failed && <p role="alert" className="mt-1 text-[12px] text-danger">{t("data.chart.failed", { reason: failed })}</p>}
    </div>
  );
}
