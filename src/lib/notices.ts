// The desktop app's one-time notices: the small cards at the bottom left
// (src/components/AppNotices.tsx). One mechanism for all of them:
// - they are asked in order, and only the first one due is shown, so at most
//   one is ever on screen (and after one closes, no other in the same page);
// - one whose answer is not known yet holds the ones after it, so a later
//   card never appears first and then swaps under the pointer;
// - a dismissal is for good: either button, the X or Escape. It is kept in
//   the workspace's onboarding hint record (hintsSeen), which updates and tour
//   replays never clear, plus a browser-storage copy that holds at once.
// The free trial's own notices (one a day per state, main's record) and the
// card for someone with a Cloud (Not now kept per card) decide their own
// days; they are entries here so that they never share the corner.
import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

/** The card after the update that introduces OpenMausBot Cloud's free trial
 * (CloudTrialIntro). Showing it again some day is a new id here. */
export const CLOUD_INTRO = "cloud-trial-intro-v1";
/** The free trial's notice on the person's own Cloud (CloudTrialNotice). */
export const CLOUD_TRIAL_NOTICE = "cloud-trial-notice";
/** This computer's card about My Cloud for someone with a plan (CloudNotice). */
export const CLOUD_NOTICE = "cloud-notice";
/** "Star us on GitHub", asked once. */
export const STAR_NOTICE = "github-star-dismissed";

export type NoticeId = typeof CLOUD_INTRO | typeof CLOUD_TRIAL_NOTICE | typeof CLOUD_NOTICE | typeof STAR_NOTICE;

/** The order they are asked in. */
export const NOTICES: readonly NoticeId[] = [CLOUD_INTRO, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE, STAR_NOTICE];

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

const stored = (id: string): string | null => { try { return localStorage.getItem(id); } catch { return null; } };
const store = (id: string, value: string) => { try { localStorage.setItem(id, value); } catch { /* The workspace record still keeps it. */ } };

/** Dismissed for good: in the workspace record, or on this device. */
export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return hintSeen(record, id) || stored(id) === "1";
}

/** Marks a notice dismissed on this device and returns the workspace patch
 * to send (null when the record already has it). */
export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  store(id, "1");
  return hintSeenPatch(record, id);
}

/** This computer's calendar day, which "once a day" counts in. */
export function localDay(now: number): string {
  const date = new Date(now), two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

// The card after the update shows at most once a calendar day, on at most
// three days (one for someone who closed the earlier Pro card), then counts
// as dismissed. The days are kept on this device; their count is kept in the
// workspace record too, so a cleared browser storage does not restart them.
const INTRO_DAYS = `${CLOUD_INTRO}:days`;
const introDayHint = (count: number) => `${CLOUD_INTRO}:day-${count}`;
/** How many days the workspace record says it was shown on. */
const recordedDays = (record: OnboardingStatus | undefined) => Math.max(0, ...(record?.hintsSeen ?? [])
  .map(id => id.startsWith(`${CLOUD_INTRO}:day-`) ? Number(id.slice(`${CLOUD_INTRO}:day-`.length)) : 0)
  .filter(count => Number.isSafeInteger(count)));
/** The Pro cards this one replaces: someone who closed one sees this on one day only. */
export const OLD_PRO_DISMISSALS = ["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"] as const;
const MAX_INTRO_DAYS = 3;

function introDays(): string[] {
  try {
    const parsed: unknown = JSON.parse(stored(INTRO_DAYS) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(-MAX_INTRO_DAYS) : [];
  } catch { return []; }
}

/** Where the card after the update stands today: "due" (not shown yet
 * today), "shown-today" (it was; it waits for tomorrow and holds the cards
 * after it) or "done" (closed for good, or shown on all its days). */
export function introStage(record: OnboardingStatus | undefined, now: number): "due" | "shown-today" | "done" {
  if (noticeSeen(record, CLOUD_INTRO)) return "done";
  const days = introDays();
  if (days.includes(localDay(now))) return "shown-today";
  const counted = Math.max(days.length, recordedDays(record));
  const limit = OLD_PRO_DISMISSALS.some(id => noticeSeen(record, id)) ? 1 : MAX_INTRO_DAYS;
  return counted >= limit ? "done" : "due";
}

/** The card after the update is on screen today: counted once for the day,
 * here and in the workspace record (the patch to send, or null). */
export function introShown(record: OnboardingStatus | undefined, now: number): { onboarding: { hintsSeen: string[] } } | null {
  const days = introDays(), today = localDay(now);
  if (days.includes(today)) return null;
  const next = [...days, today].slice(-MAX_INTRO_DAYS);
  store(INTRO_DAYS, JSON.stringify(next));
  return hintSeenPatch(record, introDayHint(Math.min(Math.max(recordedDays(record) + 1, next.length), MAX_INTRO_DAYS)));
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
