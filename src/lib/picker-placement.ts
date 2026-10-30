export type Box = { left: number; right: number; top: number; bottom: number };
export type Size = { width: number; height: number };
export type PickerSide = { vertical: "below" | "above"; edge: "left" | "right" };

export interface PickerPlacement extends PickerSide {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  origin: string;
}

export const PICKER_GAP = 6;
export const PICKER_MARGIN = 8;
export const PICKER_MAX_HEIGHT = 480;

export function pickerPlacement(anchor: Box, menu: Size, viewport: Size, locked?: PickerSide, tallest = PICKER_MAX_HEIGHT): PickerPlacement {
  const edge = locked?.edge ?? ((anchor.left + anchor.right) / 2 > viewport.width / 2 ? "right" : "left");
  const width = Math.max(0, Math.min(menu.width, viewport.width - PICKER_MARGIN * 2));
  const wanted = edge === "right" ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(wanted, PICKER_MARGIN), Math.max(PICKER_MARGIN, viewport.width - width - PICKER_MARGIN));
  const below = viewport.height - anchor.bottom - PICKER_GAP - PICKER_MARGIN;
  const above = anchor.top - PICKER_GAP - PICKER_MARGIN;
  const vertical = locked?.vertical ?? (menu.height <= below || below >= above ? "below" : "above");
  const maxHeight = Math.max(0, Math.min(tallest, vertical === "below" ? below : above));
  const origin = `${vertical === "below" ? "top" : "bottom"} ${edge}`;
  return vertical === "below"
    ? { vertical, edge, left, width, top: anchor.bottom + PICKER_GAP, maxHeight, origin }
    : { vertical, edge, left, width, bottom: viewport.height - anchor.top + PICKER_GAP, maxHeight, origin };
}
