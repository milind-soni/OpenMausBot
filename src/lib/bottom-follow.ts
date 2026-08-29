/** Subpixel slack for "at the rest position" — not a magnet zone. A larger
 * value used to re-pin follow ~48px early and then jump the pane to the end. */
export const BOTTOM_FOLLOW_THRESHOLD = 4;

/**
 * Resume automatic bottom-follow only when the reader is already at the
 * rest position and still moving toward it. Re-pinning must not imply a
 * snap; the scroll effect follows new content, it does not yank the viewport.
 */
export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}
