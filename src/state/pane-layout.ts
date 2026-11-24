export type SplitDirection = "beside" | "below";
export type PaneLayout = string | {
  direction: SplitDirection;
  ratio: number;
  first: PaneLayout;
  second: PaneLayout;
};

export const MAIN_PANE = "primary";
export function firstPane(layout: PaneLayout): string {
  return typeof layout === "string" ? layout : firstPane(layout.first);
}

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
