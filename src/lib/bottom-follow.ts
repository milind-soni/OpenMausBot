export const BOTTOM_FOLLOW_THRESHOLD = 48;

/**
 * Resume automatic bottom-follow only when the reader is moving toward the
 * latest message. An upward movement can still be within the near-bottom
 * threshold and must never re-pin the transcript.
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
