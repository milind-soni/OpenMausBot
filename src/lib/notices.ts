import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

/** The What's new popup's campaign: each person sees it once. A new id shows it once more. */
export const WHATS_NEW_NOTICE = "whats-new-2026-11";
export const UPDATES_CONSENT_NOTICE = "updates-consent";
/** The Simple mode popup, once per browser (simple-mode-prompt.ts keeps whether it was closed). */
export const SIMPLE_MODE_NOTICE = "simple-mode-prompt";
export const CLOUD_INTRO = "cloud-trial-intro-v1";
export const CLOUD_TRIAL_NOTICE = "cloud-trial-notice";
export const CLOUD_NOTICE = "cloud-notice";
export const STAR_NOTICE = "github-star-dismissed";
/** Bots on this computer and on another place of the person's (two-places.ts): dismissed per place, by main. */
export const TWO_PLACES_NOTICE = "two-places";
export const PRODUCT_HUNT_NOTICE = "product-hunt-launch-2026-10";
export const PRODUCT_HUNT_URL = "https://www.producthunt.com/products/mausbot";
export const PRODUCT_HUNT_UNTIL = Date.UTC(2026, 10, 1);
export const BOAT_OFFER_NOTICE = "boat-credit-2026-11";

/**
 * Every notice, in the order a launch asks them: one launch shows one notice, the first one due, and only the product-updates
 * question may follow it there. The rest wait for later launches, in this order.
 */
export const NOTICES = [
  SIMPLE_MODE_NOTICE,
  WHATS_NEW_NOTICE,
  UPDATES_CONSENT_NOTICE,
  TWO_PLACES_NOTICE,
  PRODUCT_HUNT_NOTICE,
  CLOUD_INTRO,
  CLOUD_TRIAL_NOTICE,
  CLOUD_NOTICE,
  BOAT_OFFER_NOTICE,
  STAR_NOTICE,
] as const;

export type NoticeId = (typeof NOTICES)[number];

export type NoticeFacts = Record<NoticeId, boolean | null>;

/** `launch`: the notice this launch already showed (launchNotice), the only one besides the product-updates question that
 * may show again in it. */
export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean, launch: NoticeId | null = null): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id) || (launch !== null && id !== launch && id !== UPDATES_CONSENT_NOTICE)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
}

const LAUNCH_KEY = "omb.launch.notice";
// Where browser storage is blocked, this page's memory stands in for it, so a claim still holds for the page.
let launchMemory: NoticeId | null = null;
const isNotice = (id: unknown): id is NoticeId => (NOTICES as readonly unknown[]).includes(id);

/** The first notice this launch showed, kept for the window's session, so a reload is the same launch. */
export function launchNotice(): NoticeId | null {
  try {
    const id = sessionStorage.getItem(LAUNCH_KEY);
    if (isNotice(id)) return id;
  } catch {}
  return launchMemory;
}

/** The first claim of a launch holds; a later one changes nothing. */
export function markLaunchNotice(id: NoticeId): void {
  if (launchNotice()) return;
  try {
    sessionStorage.setItem(LAUNCH_KEY, id);
  } catch {
    launchMemory = id;
  }
}

const stored = (id: string): string | null => { try { return localStorage.getItem(id); } catch { return null; } };
const store = (id: string, value: string) => { try { localStorage.setItem(id, value); } catch {} };

export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return hintSeen(record, id) || stored(id) === "1";
}

export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  store(id, "1");
  return hintSeenPatch(record, id);
}

export function localDay(now: number): string {
  const date = new Date(now), two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

const INTRO_DAYS = `${CLOUD_INTRO}:days`;
const introDayHint = (count: number) => `${CLOUD_INTRO}:day-${count}`;
const recordedDays = (record: OnboardingStatus | undefined) => Math.max(0, ...(record?.hintsSeen ?? [])
  .map(id => id.startsWith(`${CLOUD_INTRO}:day-`) ? Number(id.slice(`${CLOUD_INTRO}:day-`.length)) : 0)
  .filter(count => Number.isSafeInteger(count)));
export const OLD_PRO_DISMISSALS = ["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"] as const;
const MAX_INTRO_DAYS = 3;

function introDays(): string[] {
  try {
    const parsed: unknown = JSON.parse(stored(INTRO_DAYS) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(-MAX_INTRO_DAYS) : [];
  } catch { return []; }
}

export function introStage(record: OnboardingStatus | undefined, now: number): "due" | "shown-today" | "done" {
  if (noticeSeen(record, CLOUD_INTRO)) return "done";
  const days = introDays();
  if (days.includes(localDay(now))) return "shown-today";
  const counted = Math.max(days.length, recordedDays(record));
  const limit = OLD_PRO_DISMISSALS.some(id => noticeSeen(record, id)) ? 1 : MAX_INTRO_DAYS;
  return counted >= limit ? "done" : "due";
}

export function introShown(record: OnboardingStatus | undefined, now: number): { onboarding: { hintsSeen: string[] } } | null {
  const days = introDays(), today = localDay(now);
  if (days.includes(today)) return null;
  const next = [...days, today].slice(-MAX_INTRO_DAYS);
  store(INTRO_DAYS, JSON.stringify(next));
  return hintSeenPatch(record, introDayHint(Math.min(Math.max(recordedDays(record) + 1, next.length), MAX_INTRO_DAYS)));
}

export const LAUNCHED_AT = Date.now();

export function usedBefore(
  bots: ReadonlyArray<{ tasks?: ReadonlyArray<{ createdAt?: number; usage?: { turns: number } }> }>,
  launchedAt = LAUNCHED_AT,
): boolean {
  return bots.some(bot => bot.tasks?.some(task => (task.createdAt ?? Infinity) < launchedAt && (task.usage?.turns ?? 0) > 0) ?? false);
}
