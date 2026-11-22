// Views the desktop app covers with its own native view of the same browser. The person sees the page itself there, so
// such a view takes no frames, neither a screencast nor stills, until the native view hides again (an overlay, the
// panel's dialog card, the app window closing). Every other view of the browser, a phone's or another device's, runs
// its own screencast and is not affected.

const coveredViews = new WeakSet<object>();

/** Whether the desktop app shows its native view over this one. */
export function covered(viewer: object): boolean {
  return coveredViews.has(viewer);
}

/**
 * The desktop app showed (`on`) or hid its native view over `viewer`. `heldElsewhere` says whether another person's
 * hold hides the view anyway; the view hides for either reason and shows again, with a still, once neither applies.
 */
export function coverView(viewer: { hide(hidden: boolean): Promise<void> }, on: boolean, heldElsewhere: boolean): Promise<void> {
  if (on) coveredViews.add(viewer);
  else coveredViews.delete(viewer);
  return viewer.hide(on || heldElsewhere);
}
