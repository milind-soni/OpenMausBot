/** A mid-turn send is waiting: the composer can interrupt so those words
 * run now instead of after the current turn finishes. The control itself is
 * the labelled Steer button on the queued row — an unexplained green arrow
 * in the composer was a puzzle, and this is not a place for one. */
export function composerCanInjectNow(busy: boolean, locked: boolean, pendingCount: number): boolean {
  return busy && !locked && pendingCount > 0;
}
