export type SplitDirection = "beside" | "below";
export type PaneLayout = string | {
  direction: SplitDirection;
  ratio: number;
  first: PaneLayout;
  second: PaneLayout;
};

export const MAIN_PANE = "primary";
export function replacePane(layout: PaneLayout, id: string, next: PaneLayout | null): PaneLayout | null {
  if (typeof layout === "string") return layout === id ? next : layout;
  const first = replacePane(layout.first, id, next);
  const second = replacePane(layout.second, id, next);
  if (!first || !second) return first ?? second;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function resizePane(layout: PaneLayout, divider: string, ratio: number): PaneLayout {
  if (typeof layout === "string") return layout;
  if (divider === "") return { ...layout, ratio: Math.max(0.2, Math.min(0.8, ratio)) };
  const side = divider[0] === "0" ? "first" : "second";
  return { ...layout, [side]: resizePane(layout[side], divider.slice(1), ratio) };
}

export const MAX_PANES = 4;
export type PanePreset = "columns" | "rows" | "stack" | "grid";
export type PaneEdge = "left" | "right" | "top" | "bottom";
export const presetSize = { columns: 2, rows: 2, stack: 3, grid: 4 } as const;
export const emptyPane = (id: string) => id.startsWith("slot:");
export function paneIds(layout: PaneLayout): string[] {
  return typeof layout === "string" ? [layout] : [...paneIds(layout.first), ...paneIds(layout.second)];
}

const pair = (direction: SplitDirection, first: PaneLayout, second: PaneLayout): PaneLayout => ({ direction, first, second, ratio: 0.5 });

export function presetLayout(layout: PaneLayout, preset: PanePreset): PaneLayout | null {
  const shape = currentPreset(layout);
  const ids = paneIds(layout);
  if (shape === "stack" || shape === "grid") [ids[1], ids[2]] = [ids[2], ids[1]];
  const occupied = ids.filter(id => !emptyPane(id));
  if (occupied.length > presetSize[preset]) return null;
  if (shape === preset) {
    const balance = (node: PaneLayout): PaneLayout => typeof node === "string" ? node : pair(node.direction, balance(node.first), balance(node.second));
    return balance(layout);
  }
  const [a, b, c, d] = Array.from({ length: MAX_PANES }, (_, i) => occupied[i] ?? `slot:${i}`);
  switch (preset) {
    case "columns": return pair("beside", a, b);
    case "rows": return pair("below", a, b);
    case "stack": return pair("beside", pair("below", a, c), b);
    case "grid": return pair("beside", pair("below", a, c), pair("below", b, d));
  }
}

export function placePane(layout: PaneLayout, source: string, target: string, edge: PaneEdge | "fill"): PaneLayout | null {
  const ids = paneIds(layout);
  if (!ids.includes(target) || source === target) return null;
  const moving = ids.includes(source);
  if (edge === "fill") {
    if (!emptyPane(target)) return null;
    if (!moving) return replacePane(layout, target, source);
    const swap = (node: PaneLayout): PaneLayout => typeof node === "string"
      ? node === source ? target : node === target ? source : node
      : { ...node, first: swap(node.first), second: swap(node.second) };
    return swap(layout);
  }
  if (emptyPane(target) || (!moving && ids.length >= MAX_PANES)) return null;
  const rest = moving ? replacePane(layout, source, null) : layout;
  if (!rest) return null;
  const before = edge === "left" || edge === "top";
  const direction = edge === "left" || edge === "right" ? "beside" : "below";
  return replacePane(rest, target, pair(direction, before ? source : target, before ? target : source));
}

export function currentPreset(layout: PaneLayout): PanePreset | undefined {
  if (typeof layout === "string") return;
  const { first, second, direction } = layout;
  if (typeof first === "string" && typeof second === "string") return direction === "beside" ? "columns" : "rows";
  const rows = (node: PaneLayout) => typeof node !== "string" && node.direction === "below" && typeof node.first === "string" && typeof node.second === "string";
  if (direction === "beside" && rows(first)) return typeof second === "string" ? "stack" : rows(second) ? "grid" : undefined;
}
