// The desktop app's one-time notices: the small dismissible cards at the
// bottom left (src/components/AppNotices.tsx). One mechanism for all of them:
// - they are asked in order, and only the first one due is shown, so at most
//   one is ever on screen (the host also shows at most one per launch);
// - one whose answer is not known yet holds the ones after it, so the star
//   never appears before the Pro card and then swaps under the pointer;
// - a dismissal is for good: either button, the X or Escape. It is kept in
//   the workspace's onboarding hint record (hintsSeen), which updates and tour
//   replays never clear, plus a browser-storage copy that holds at once.
import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

/** The Pro plans card. "-v3" is the October 2026 release showing it once
 * more to everyone eligible, including people who dismissed the earlier
 * cards ("pro-introduction-dismissed", "-v2"), which no longer count.
 * Showing it again some day is a deliberate new id here, never a reset of
 * anyone's record. */
export const PRO_NOTICE = "pro-introduction-dismissed-v3";
/** "Star us on GitHub", asked once. */
export const STAR_NOTICE = "github-star-dismissed";

export type NoticeId = typeof PRO_NOTICE | typeof STAR_NOTICE;

/** The order they are asked in. */
export const NOTICES: readonly NoticeId[] = [PRO_NOTICE, STAR_NOTICE];

/** Whether each notice is due now: null while that is not known yet. */
export type NoticeFacts = Record<NoticeId, boolean | null>;

/** The one notice to show, or null. */
export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
}

/** Dismissed for good: in the workspace record, or on this device. */
export function noticeSeen(record: OnboardingStatus | undefined, id: NoticeId): boolean {
  if (hintSeen(record, id)) return true;
  try { return localStorage.getItem(id) === "1"; } catch { return false; }
}

/** Marks a notice dismissed on this device and returns the workspace patch
 * to send (null when the record already has it). */
export function dismissNotice(record: OnboardingStatus | undefined, id: NoticeId): { onboarding: { hintsSeen: string[] } } | null {
  try { localStorage.setItem(id, "1"); } catch { /* The workspace record still keeps it. */ }
  return hintSeenPatch(record, id);
}

/** When this window opened: the line between this launch and earlier ones. */
export const LAUNCHED_AT = Date.now();

/** Not brand new: a conversation started before this launch has had at
 * least one reply (a settled turn). */
export function usedBefore(
  bots: ReadonlyArray<{ tasks?: ReadonlyArray<{ createdAt?: number; usage?: { turns: number } }> }>,
  launchedAt = LAUNCHED_AT,
): boolean {
  return bots.some(bot => bot.tasks?.some(task => (task.createdAt ?? Infinity) < launchedAt && (task.usage?.turns ?? 0) > 0) ?? false);
}
