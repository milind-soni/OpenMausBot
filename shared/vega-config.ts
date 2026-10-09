// The one Vega config every chart in OMB is drawn with: the Data panel
// (vega-embed), the server's SVG/PNG for phones, Slack and email, and the
// headless render check all pass this same object, so a chart looks the same
// wherever it lands (PLAN D6, risk 6: theme drift). Vega-Lite accepts it as
// `config`; Vega as the runtime config.
//
// Only two themes exist here, light and dark, chosen by the caller from the
// skin's `--code-color-scheme`. The ink and hairline values are the Midnight
// and Atelier tokens in src/styles.css; the skins' accents are not used for
// marks, because a series must keep its colour between the panel and a PNG
// in an email, and a brown-first palette (Atelier) next to a blue-first one
// (Midnight) would break that.

export type VegaTheme = "light" | "dark";

/** The app's `--font-sans` stack. Node renders through resvg, which walks
 * the list against the system fonts it finds, so the stack ends in a
 * generic family. */
export const VEGA_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif';

/** Ten categorical colours of middling luminance so every one of them reads
 * on both #111 and white (≥ 3:1 each way, see shared/vega-config.test.ts).
 * Hue order alternates warm and cool so neighbouring series differ at a glance. */
export const VEGA_CATEGORY_RANGE: readonly string[] = [
  "#3b82f6", // blue
  "#ea580c", // orange
  "#059669", // emerald
  "#c026d3", // fuchsia
  "#a16207", // gold
  "#8b5cf6", // violet
  "#0d9488", // teal
  "#e11d48", // rose
  "#4d7c0f", // olive
  "#6b7280", // grey
];

const INK = {
  dark: { text: "#fcfcfc", muted: "#a3a3a3", hairline: "#333333", surface: "#111111" },
  light: { text: "#1a1a18", muted: "#6b6559", hairline: "#c8bda8", surface: "#fbf8f2" },
} as const;

/** The surface a PNG is laid on when it cannot be transparent (email, Slack). */
export function vegaSurface(theme: VegaTheme): string {
  return INK[theme].surface;
}

export function vegaConfig(theme: VegaTheme): Record<string, unknown> {
  const ink = INK[theme];
  const text = { font: VEGA_FONT, labelFont: VEGA_FONT, titleFont: VEGA_FONT, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500 };
  return {
    // The panel's card and the phone's view supply the ground; a PNG adds its own.
    background: "transparent",
    font: VEGA_FONT,
    padding: 8,
    view: { stroke: null },
    title: { color: ink.text, subtitleColor: ink.muted, font: VEGA_FONT, fontSize: 13, fontWeight: 600, anchor: "start", offset: 12 },
    axis: {
      ...text,
      labelColor: ink.muted,
      titleColor: ink.muted,
      titlePadding: 8,
      labelPadding: 6,
      domainColor: ink.hairline,
      domainWidth: 1,
      tickColor: ink.hairline,
      tickSize: 4,
      gridColor: ink.hairline,
      gridWidth: 1,
      gridOpacity: 0.6,
    },
    // Hairline grid behind the values only; the category axis keeps its baseline.
    axisX: { grid: false },
    axisY: { grid: true, domain: false, ticks: false },
    legend: {
      ...text,
      labelColor: ink.muted,
      titleColor: ink.muted,
      symbolSize: 60,
      symbolType: "circle",
      labelLimit: 140,
      padding: 0,
      rowPadding: 2,
      columnPadding: 8,
      offset: 12,
    },
    range: {
      category: [...VEGA_CATEGORY_RANGE],
      // High values must pop against the ground: light-to-dark blues on
      // paper, dark-to-bright viridis on a dark surface.
      heatmap: { scheme: theme === "dark" ? "viridis" : "blues" },
      ramp: { scheme: theme === "dark" ? "viridis" : "blues" },
    },
    mark: { color: VEGA_CATEGORY_RANGE[0] },
    bar: { cornerRadiusEnd: 1 },
    line: { strokeWidth: 2, strokeJoin: "round", strokeCap: "round" },
    area: { opacity: 0.75, line: false },
    point: { filled: true, size: 36, opacity: 0.8 },
    circle: { size: 36, opacity: 0.8 },
    // A hairline in the surface colour separates pie slices and heatmap cells.
    arc: { stroke: ink.surface, strokeWidth: 1 },
    rect: { stroke: ink.surface, strokeWidth: 1 },
    text: { color: ink.text, font: VEGA_FONT },
    scale: { bandPaddingInner: 0.25 },
  };
}
