// The project's announcement cards on this page: which one, if any, is due, and the record that each person sees each
// card once. The server hands over the cards (server/routes/announcements.ts); everything about who sees one is decided
// here, from what the page already knows, and nothing about the person leaves it. AppNotices shows the card through the
// notice queue, after every notice someone must act on.
import { useEffect, useSyncExternalStore } from "react";
import { track } from "@/lib/analytics";
import { hintSeen, type OnboardingStatus } from "@/lib/onboarding";
import { localDay } from "@/lib/notices";
import type { CloudPlanView } from "@/lib/cloud-plan";
import type { ManagedPolicySummary } from "@/state/config-status";
import { api, type AppState } from "@/state/store";
import {
  ADMIN_PLACES, audienceMatches, cardPlaces, parseAnnouncementCard, type AnnouncementCard, type AnnouncementFacts, type AnnouncementKind,
  type AnnouncementPlan, type AnnouncementPlatform, type AnnouncementSurface,
} from "../../shared/announcements";

/** Sponsor cards (the announcements' and the app's own) for a Team Cloud's members who are not its owner or an admin. Off:
 * a sponsor's card is for whoever chooses the team's providers. The owner's call; flip this to show them to every member. */
export const SPONSOR_CARDS_FOR_TEAM_MEMBERS = false;
/** At most one sponsor card in this many days, per person. */
export const SPONSOR_REST_DAYS = 7;
export const ANNOUNCEMENT_REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

const SEEN_PREFIX = "announcement:";
const SPONSOR_DAY_PREFIX = "announcement-sponsor:";
const LAUNCH_KEY = "omb.launch.announcement";
const SPONSOR_DAY_STORAGE = "omb.announcement.sponsor-day";
/** The workspace record keeps this many cards' marks at most, beside the app's own hints (server/config.ts caps them all). */
const MAX_KEPT_HINTS = 10;
const HINTS_CAP = 100;

export const seenKey = (id: string) => `${SEEN_PREFIX}${id}`;
export const sponsorDayKey = (day: string) => `${SPONSOR_DAY_PREFIX}${day}`;

// ---- The cards this server hands over: asked at launch, then about hourly while the app is in use.

let cards: AnnouncementCard[] = [];
let askedAt: number | null = null;
let answered = false;
let asking = false;
const listeners = new Set<() => void>();

function readCards(answer: unknown): AnnouncementCard[] {
  const list = (answer as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const parsed = parseAnnouncementCard(raw);
    return parsed.ok ? [parsed.card] : [];
  });
}

function ask(now: number): void {
  if (asking || (askedAt !== null && now >= askedAt && now - askedAt < (answered ? ANNOUNCEMENT_REFRESH_MS : RETRY_MS))) return;
  asking = true;
  askedAt = now;
  void api("/api/announcements").then((answer) => { cards = readCards(answer); answered = true; }, () => {})
    .finally(() => { asking = false; for (const listener of listeners) listener(); });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => cards;

/** The cards this page's server handed over; none until it answers, and none where `enabled` is false. Each render asks
 * again once the last answer is an hour old, so a page in use follows the file without a timer of its own. */
export function useAnnouncementCards(enabled: boolean, now: () => number = Date.now): AnnouncementCard[] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (enabled) ask(now()); });
  return enabled ? current : [];
}

/** Tests: start from a page that has asked nothing. */
export function forgetAnnouncementCards(): void {
  cards = []; askedAt = null; answered = false; asking = false;
}

// ---- What this page knows.

const stored = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };

export function announcementPlatform(userAgent: string | undefined): AnnouncementPlatform | null {
  if (!userAgent) return null;
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux|X11|CrOS/.test(userAgent)) return "linux";
  return null;
}

/** The desktop app's own page, a MausBot Cloud's page, or any other server's. */
export function announcementSurface(local: boolean, cloudHome: boolean): AnnouncementSurface {
  return local ? "desktop" : cloudHome ? "cloud" : "server";
}

/** On the desktop's page, from its Cloud sign-in (null while it is read); on a Cloud's page, that Cloud's; elsewhere unknown. */
export function announcementPlan(surface: AnnouncementSurface, view: CloudPlanView | null, team: boolean): AnnouncementPlan | null | undefined {
  if (surface === "cloud") return team ? "team" : "cloud";
  if (surface === "server" || !view) return undefined;
  if (view.kind === "unknown" || view.kind === "connecting") return null;
  return view.kind === "free" || view.kind === "signed-out" || view.kind === "removed" ? "none" : "cloud";
}

const PROVIDER_KEYS = ["anthropic", "openai", "openrouter", "openaiCompat", "xai", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta", "deepseek", "opencodeGo"] as const;

export function announcementConditions(state: Pick<AppState, "config" | "bots" | "routines" | "routinesLoadState">): AnnouncementFacts["conditions"] {
  const config = state.config as Partial<Record<(typeof PROVIDER_KEYS)[number], { configured?: boolean }>> | null;
  return {
    no_api_key: Boolean(config) && !PROVIDER_KEYS.some((key) => config?.[key]?.configured === true),
    one_bot_only: state.bots.filter((bot) => !bot.hidden).length === 1,
    no_routine: state.routinesLoadState === "ready" && state.routines.length === 0,
  };
}

/** An organization's policy that limits the providers people may use: no sponsor's card there. A Team Cloud's own rules
 * are not that. */
export function providersRestricted(policy: ManagedPolicySummary | null | undefined): boolean {
  return Boolean(policy && !policy.team && (policy.companyModelsOnly || policy.allowedEngines !== "all"));
}

// ---- Who has seen what: this browser's storage, this desktop's record for every page its window shows, and the
// workspace's own record. A Team Cloud's record is the whole team's, so there only the first two count.

export interface SeenRecord {
  record: OnboardingStatus | undefined;
  /** This desktop's record (DesktopNoticesState.seen), on any page of its window; empty in a browser. */
  desktop: readonly string[];
  /** A Team Cloud's page. */
  team: boolean;
}

const has = (seen: SeenRecord, key: string) => stored(key) === "1" || seen.desktop.includes(key) || (!seen.team && hintSeen(seen.record, key));

export function cardSeen(seen: SeenRecord, id: string): boolean {
  return has(seen, seenKey(id));
}

/** The last day this person was shown a sponsor's card, as YYYY-MM-DD, or null. */
export function lastSponsorDay(seen: SeenRecord): string | null {
  const marks = [...seen.desktop, ...(seen.team ? [] : seen.record?.hintsSeen ?? [])]
    .filter((entry) => entry.startsWith(SPONSOR_DAY_PREFIX)).map((entry) => entry.slice(SPONSOR_DAY_PREFIX.length));
  const days = [stored(SPONSOR_DAY_STORAGE), ...marks].filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day));
  return days.sort().at(-1) ?? null;
}

const dayNumber = (day: string) => { const [year, month, date] = day.split("-").map(Number); return Math.round(new Date(year!, month! - 1, date!).getTime() / 86_400_000); };

export function sponsorRested(seen: SeenRecord, now: number): boolean {
  const last = lastSponsorDay(seen);
  return last === null || dayNumber(localDay(now)) - dayNumber(last) >= SPONSOR_REST_DAYS;
}

/** The workspace record's hints with one more announcement mark: marks of cards no longer in the feed go first, and at
 * most MAX_KEPT_HINTS stay, so the record never fills with them. A sponsor day replaces the last one. Null when nothing
 * changes or the record has no room. */
export function hintsWith(record: OnboardingStatus | undefined, key: string, liveIds: ReadonlySet<string>): string[] | null {
  const hints = record?.hintsSeen ?? [];
  if (hints.includes(key)) return null;
  const sponsorDay = key.startsWith(SPONSOR_DAY_PREFIX);
  const others = hints.filter((hint) => !hint.startsWith(SEEN_PREFIX) && !hint.startsWith(SPONSOR_DAY_PREFIX));
  const marks = hints.filter((hint) => hint.startsWith(SEEN_PREFIX) && liveIds.has(hint.slice(SEEN_PREFIX.length)));
  const days = hints.filter((hint) => hint.startsWith(SPONSOR_DAY_PREFIX));
  const next = [...others, ...[...marks, ...(sponsorDay ? [] : [key])].slice(-MAX_KEPT_HINTS), ...(sponsorDay ? [key] : days.slice(-1))];
  return next.length > HINTS_CAP ? null : next;
}

export interface RememberOptions {
  desktop?: { seen(id: string): Promise<void> };
  /** The cards the server handed over: marks of any other card leave the workspace record. */
  liveIds: ReadonlySet<string>;
  /** Sends the workspace record's new hints. */
  save: (hintsSeen: string[]) => void;
}

function remember(seen: SeenRecord, key: string, options: RememberOptions): void {
  void options.desktop?.seen(key).catch(() => {});
  if (seen.team) return;
  const hints = hintsWith(seen.record, key, options.liveIds);
  if (hints) options.save(hints);
}

/** The person closed or acted on this card: it never shows to them again, here or on their other pages. */
export function rememberCardSeen(seen: SeenRecord, id: string, options: RememberOptions): void {
  store(seenKey(id), "1");
  remember(seen, seenKey(id), options);
}

/** A sponsor's card was shown today: the next one waits SPONSOR_REST_DAYS. */
export function rememberSponsorDay(seen: SeenRecord, now: number, options: RememberOptions): void {
  const day = localDay(now);
  store(SPONSOR_DAY_STORAGE, day);
  remember(seen, sponsorDayKey(day), options);
}

// ---- One remote card per launch: the card this window's session showed.

let launchMemory: string | null = null;
export function launchAnnouncement(): string | null {
  try { return sessionStorage.getItem(LAUNCH_KEY) ?? launchMemory; } catch { return launchMemory; }
}
export function markLaunchAnnouncement(id: string): void {
  if (launchAnnouncement()) return;
  try { sessionStorage.setItem(LAUNCH_KEY, id); } catch { launchMemory = id; }
}

// ---- The card that is due.

export interface PickContext {
  facts: AnnouncementFacts;
  seen: SeenRecord;
  /** A branded build: no remote cards at all, as no What's new popup. */
  branded: boolean;
  /** Sponsor cards may show to this person here (not where an organization restricts providers, nor to a Team Cloud's
   * members unless SPONSOR_CARDS_FOR_TEAM_MEMBERS). */
  sponsors: boolean;
  /** This person may change this place's settings: a card that opens an admin's place skips everyone else. */
  admin: boolean;
}

/** The first card in file order that is due, "wait" while a fact the first candidate needs is still loading, or null. */
export function pickAnnouncement(list: readonly AnnouncementCard[], context: PickContext): AnnouncementCard | "wait" | null {
  if (context.branded) return null;
  const now = context.facts.nowMs, launch = launchAnnouncement();
  if (launch !== null && cardSeen(context.seen, launch)) return null;
  const rested = sponsorRested(context.seen, now);
  for (const card of list) {
    if ((card.starts && Date.parse(card.starts) > now) || Date.parse(card.ends) <= now) continue;
    if (cardSeen(context.seen, card.id) || (launch !== null && launch !== card.id)) continue;
    if (card.kind === "sponsor" && (!context.sponsors || (!rested && launch !== card.id))) continue;
    if (!context.admin && cardPlaces(card).some((place) => ADMIN_PLACES.has(place))) continue;
    const matches = audienceMatches(card.audience, context.facts);
    if (matches === null) return "wait";
    if (matches) return card;
  }
  return null;
}

export type AnnouncementAction = "shown" | "primary" | "secondary" | "close";

/** One event per card and step, under the same analytics switch as every other event. The id is the card's own, from
 * the public file, the same for everyone. */
export function reportAnnouncement(card: { id: string; kind: AnnouncementKind }, action: AnnouncementAction): void {
  track("announcement", { id: card.id, kind: card.kind, action });
}
