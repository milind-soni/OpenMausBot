import type { CSSProperties } from "react";
import { widgetNumber, type WidgetNode } from "../../../shared/widget";

export const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", baseline: "items-baseline", stretch: "items-stretch" };
export const JUSTIFY: Record<string, string> = {
  start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around", evenly: "justify-evenly", stretch: "justify-stretch",
};
export const BACKGROUND: Record<string, string> = { surface: "bg-composer", secondary: "bg-inset", tertiary: "bg-ink/[0.07]", elevated: "bg-card" };
export const INK: Record<string, string> = {
  primary: "text-ink", secondary: "text-ink-secondary", tertiary: "text-ink-tertiary", success: "text-success", warning: "text-warning", danger: "text-danger",
};
export const WEIGHT: Record<string, string> = { normal: "font-normal", medium: "font-medium", semibold: "font-semibold", bold: "font-bold" };
export const TEXT_ALIGN: Record<string, string> = { start: "text-start", center: "text-center", end: "text-end" };

export const TEXT_SIZE: Record<string, readonly [string, number]> = {
  xs: ["text-[12px] leading-4", 16], sm: ["text-[13px] leading-[18px]", 18], md: ["text-[14px] leading-5", 20], lg: ["text-[16px] leading-[22px]", 22], xl: ["text-[18px] leading-[26px]", 26],
};
export const TITLE_SIZE: Record<string, readonly [string, number]> = {
  sm: ["text-[15px] leading-[22px] tracking-[-0.01em]", 22], md: ["text-[17px] leading-6 tracking-[-0.01em]", 24], lg: ["text-[20px] leading-7 tracking-[-0.01em]", 28],
  xl: ["text-[24px] leading-8 tracking-[-0.02em]", 32], "2xl": ["text-[28px] leading-9 tracking-[-0.02em]", 36], "3xl": ["text-[32px] leading-10 tracking-[-0.02em]", 40],
  "4xl": ["text-[40px] leading-[44px] tracking-[-0.02em]", 44], "5xl": ["text-[48px] leading-[52px] tracking-[-0.02em]", 52],
};
export const CAPTION_SIZE: Record<string, readonly [string, number]> = { sm: ["text-[12px] leading-4", 16], md: ["text-[13px] leading-[18px]", 18], lg: ["text-[14px] leading-5", 20] };
export const ICON_SIZE: Record<string, number> = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 28, "3xl": 32 };
export const COL_SIZE: Record<string, number> = { xs: 48, sm: 72, md: 120, lg: 180, xl: 240 };

/** Classes are written out whole: Tailwind only generates what it can read as text. */
export const BADGE_INK: Record<string, string> = {
  secondary: "text-ink-secondary",
  success: "text-[color:color-mix(in_srgb,var(--color-success)_70%,var(--color-ink))]",
  danger: "text-[color:color-mix(in_srgb,var(--color-danger)_70%,var(--color-ink))]",
  warning: "text-[color:color-mix(in_srgb,var(--color-warning)_70%,var(--color-ink))]",
  info: "text-accent-text",
  discovery: "text-[color:color-mix(in_srgb,var(--identity-purple,var(--color-accent))_58%,var(--color-ink))]",
};
export const BADGE_DOT: Record<string, string> = {
  secondary: "bg-ink-tertiary", success: "bg-success", danger: "bg-danger", warning: "bg-warning", info: "bg-accent", discovery: "bg-[color:var(--identity-purple,var(--color-accent))]",
};
export const BADGE_SOLID: Record<string, string> = {
  secondary: "bg-ink text-app", success: "bg-success", danger: "bg-danger text-danger-ink", warning: "bg-warning text-app",
  info: "bg-accent text-accent-ink", discovery: "bg-[color:var(--identity-purple,var(--color-accent))] text-app",
};
export const BADGE_SIZE: Record<string, string> = {
  sm: "h-5 px-2 text-[11px] leading-5", md: "h-[22px] px-[9px] text-[12px] leading-[22px]", lg: "h-[26px] px-[11px] text-[13px] leading-[26px]",
};

export function fourSides(value: unknown): [number, number, number, number] | undefined {
  return Array.isArray(value) && value.length === 4 && value.every((side) => typeof side === "number" && Number.isFinite(side))
    ? value as [number, number, number, number]
    : undefined;
}

const LENGTHS = ["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight"] as const;

export function boxStyle(node: WidgetNode): CSSProperties {
  const style: CSSProperties = {};
  for (const key of LENGTHS) {
    const value = node[key];
    if (typeof value === "number") style[key] = value;
    else if (value === "full") style[key] = "100%";
  }
  const padding = fourSides(node.padding);
  if (padding) style.padding = padding.map((side) => `${side}px`).join(" ");
  const flex = widgetNumber(node, "flex");
  if (flex !== undefined) style.flex = `${flex} 1 0%`;
  const ratio = widgetNumber(node, "aspectRatio");
  if (ratio) style.aspectRatio = String(ratio);
  const radius = widgetNumber(node, "radius");
  if (radius !== undefined) style.borderRadius = radius;
  const border = widgetNumber(node, "border");
  if (border) style.borderWidth = border;
  return style;
}

export function widthStyle(node: WidgetNode): CSSProperties {
  if (typeof node.width === "number") return { width: node.width, flexShrink: 0 };
  return node.width === "full" ? { width: "100%" } : {};
}

export function kids(node: WidgetNode): WidgetNode[] {
  return Array.isArray(node.children)
    ? node.children.filter((child): child is WidgetNode => Boolean(child) && typeof child === "object" && typeof child.type === "string")
    : [];
}
