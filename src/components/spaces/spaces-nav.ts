/** Pure navigation rules for the Spaces canvas.
 *
 * Cards are walked in reading order — right along a row, wrapping down to the
 * start of the next — which is why the focused view only ever shows neighbours
 * to the left and right. Movement clamps at the ends; it does not cycle, so a
 * held arrow key comes to rest instead of looping forever.
 */

export interface NavState {
  /** Currently focused card, or -1 when the canvas is empty. */
  index: number;
  count: number;
  columns: number;
}

export type NavIntent = "next" | "prev" | "up" | "down" | "first" | "last";

export function navigate(state: NavState, intent: NavIntent): number {
  const { count, columns } = state;
  if (count <= 0) return -1;

  const index = clampIndex(state.index, count);
  const last = count - 1;

  switch (intent) {
    case "first":
      return 0;
    case "last":
      return last;
    case "next":
      return Math.min(index + 1, last);
    case "prev":
      return Math.max(index - 1, 0);
    case "up": {
      const above = index - columns;
      return above >= 0 ? above : index;
    }
    case "down": {
      const below = index + columns;
      // A partly filled last row leaves gaps under the rightmost cards. Stay
      // put rather than snapping sideways to the row's only occupant.
      return below <= last ? below : index;
    }
  }
}

/** Keep a focused index valid as cards come and go. -1 means nothing to focus. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(index, 0), count - 1);
}
