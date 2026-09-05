/** Which card is the person actually looking at?
 *
 * With free panning you can slide the canvas to another bot without ever
 * pressing a key, and the composer pill must follow — otherwise you type at
 * the bot you just panned away from. Once a pan settles, this says which card
 * the view has landed on.
 */

import type { Layout, StageTransform, Viewport } from "./spaces-layout";

const PAD = 24;

export function nearestCardIndex(
  layout: Layout,
  transform: StageTransform,
  viewport: Viewport,
): number {
  const { cells } = layout;
  if (cells.length === 0) return -1;

  if (layout.view.kind === "tile") {
    // Tiles run in one row and the focused card sits at the left of the run,
    // so the winner is whichever left edge is nearest the leading margin.
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < cells.length; index += 1) {
      const onScreen = cells[index].x * transform.scale + transform.x;
      const distance = Math.abs(onScreen - PAD);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  // In the grid nothing is "leading", so the middle of the screen decides.
  const centre = { x: viewport.width / 2, y: viewport.height / 2 };
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const x = (cell.x + cell.width / 2) * transform.scale + transform.x;
    const y = (cell.y + cell.height / 2) * transform.scale + transform.y;
    const distance = (x - centre.x) ** 2 + (y - centre.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
