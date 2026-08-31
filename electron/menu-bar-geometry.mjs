/**
 * Menu-bar popover placement — no Electron imports, so tests can run in
 * Node/vitest. The tray lives at the top on macOS and typically the bottom
 * on Windows/Linux; we drop the panel under the icon when there is room
 * below, otherwise above it, then clamp to the display work area.
 */

export const MENU_BAR_POPOVER_WIDTH = 440;
export const MENU_BAR_POPOVER_HEIGHT = 620;

export function menuBarSurfaceUrl(base) {
  const url = new URL(base);
  url.searchParams.set("surface", "menubar");
  return url.toString();
}

export function menuBarPopoverBounds({
  tray,
  workArea,
  width = MENU_BAR_POPOVER_WIDTH,
  height = MENU_BAR_POPOVER_HEIGHT,
  gap = 6,
}) {
  const trayCenterX = tray.x + tray.width / 2;
  let x = Math.round(trayCenterX - width / 2);
  const roomBelow = workArea.y + workArea.height - (tray.y + tray.height) - gap;
  const preferBelow = roomBelow >= height || tray.y < workArea.y + workArea.height / 2;
  let y = preferBelow
    ? Math.round(tray.y + tray.height + gap)
    : Math.round(tray.y - height - gap);

  const minX = workArea.x + 8;
  const maxX = workArea.x + workArea.width - width - 8;
  x = maxX < minX ? workArea.x + Math.max(0, (workArea.width - width) / 2) : Math.min(Math.max(x, minX), maxX);

  const minY = workArea.y + 8;
  const maxY = workArea.y + workArea.height - height - 8;
  y = maxY < minY ? workArea.y + 8 : Math.min(Math.max(y, minY), maxY);

  return { x, y, width, height };
}
