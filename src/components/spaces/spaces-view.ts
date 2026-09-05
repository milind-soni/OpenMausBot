/** Free pan and continuous zoom for the canvas.
 *
 * The grid/focus presets in spaces-layout are snap targets. This is the layer
 * on top: once you touch the trackpad you are driving the canvas directly, in
 * both axes and at any zoom between the two presets, until a key or a click
 * snaps you back to one.
 *
 * A view maps a stage point p to the screen as `scale * p + (x, y)`, matching
 * `transform: translate3d(x, y, 0) scale(scale)` with `transform-origin: 0 0`.
 */

import { MIN_GRID_SCALE } from "./spaces-layout";

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Below this cards stop being readable; above it there is nothing to gain. */
export const MIN_ZOOM = MIN_GRID_SCALE;
export const MAX_ZOOM = 1.4;

export function clampScale(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** Two-finger scroll. Content follows the fingers, so the stage moves against
 * the delta — the same direction sense as scrolling a document. */
export function panBy(view: View, deltaX: number, deltaY: number): View {
  return { scale: view.scale, x: view.x - deltaX, y: view.y - deltaY };
}

/**
 * Pinch. The stage point under the cursor stays under the cursor, which is what
 * makes a zoom feel anchored rather than teleporting.
 *
 * p = (cursor - t) / scale, and we want scale' * p + t' = cursor, so
 * t' = cursor - scale' * (cursor - t) / scale.
 */
export function zoomAt(view: View, cursor: Point, factor: number): View {
  const scale = clampScale(view.scale * factor);
  if (scale === view.scale) return view;
  const ratio = scale / view.scale;
  return {
    scale,
    x: cursor.x - ratio * (cursor.x - view.x),
    y: cursor.y - ratio * (cursor.y - view.y),
  };
}
