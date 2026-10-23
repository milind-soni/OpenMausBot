import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

export const CLOUD_PRO_UPDATE_NOTICE = "cloud-pro-update-2026-10";
export const UPDATES_CONSENT_NOTICE = "updates-consent";
export const CLOUD_INTRO = "cloud-trial-intro-v1";
export const CLOUD_TRIAL_NOTICE = "cloud-trial-notice";
export const CLOUD_NOTICE = "cloud-notice";
export const STAR_NOTICE = "github-star-dismissed";
export const PRODUCT_HUNT_NOTICE = "product-hunt-launch-2026-10";
export const PRODUCT_HUNT_URL = "https://www.producthunt.com/products/mausbot";
export const PRODUCT_HUNT_UNTIL = Date.UTC(2026, 10, 1);

export type NoticeId = typeof CLOUD_PRO_UPDATE_NOTICE | typeof UPDATES_CONSENT_NOTICE | typeof PRODUCT_HUNT_NOTICE | typeof CLOUD_INTRO | typeof CLOUD_TRIAL_NOTICE | typeof CLOUD_NOTICE | typeof STAR_NOTICE;

export const NOTICES: readonly NoticeId[] = [CLOUD_PRO_UPDATE_NOTICE, UPDATES_CONSENT_NOTICE, PRODUCT_HUNT_NOTICE, CLOUD_INTRO, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE, STAR_NOTICE];

export type NoticeFacts = Record<NoticeId, boolean | null>;

export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
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
