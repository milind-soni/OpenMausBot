// Announcements: everything the app has announced to people, newest first, and the red dot while one is newer than the
// person last looked. The built-in ones are listed here, one entry each (docs/announcements.md says how to add one); the
// cards from the project's announcements file come from src/lib/announcements.ts.
import { useSyncExternalStore } from "react";
import { BOAT_OFFER, boatClaimMailto } from "@/lib/boat-offer";
import type { CloudSource } from "@/lib/cloud-plan";
import type { OnboardingStatus } from "@/lib/onboarding";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, dismissNotice, GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE, noticeSeen, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL,
  TEAMS_NOTICE, WHATS_NEW_NOTICE } from "@/lib/notices";
import type { LocaleKey } from "@/locales";
import type { ConfigStatus } from "@/state/config-status";
import { api } from "@/state/store";
import { ANNOUNCEMENTS_READ_HINT, announcementsReadAt as readMarkOf } from "../../shared/cloud-hints";
import { MODELGO_URL } from "../../shared/modelgo";
import { compareVersions, type AnnouncementCard } from "../../shared/announcements";
import type { ReleaseEntry } from "../../shared/release-notes";

/** What decides whom a built-in announcement was for, by its own rules (never whether they saw it, nor its dates). */
export interface HistoryFacts {
  /** A branded build: none of them. */
  branded: boolean;
  /** An organization runs this desktop; null while that is read. */
  organization: boolean | null;
  /** This desktop's own page, which sells MausBot Cloud (its Cloud sign-in). */
  cloudSale: boolean;
  /** This page shows the Cloud's own cards: This computer's page with its sign-in, or a Cloud's page in the desktop. */
  cloudCards: boolean;
  /** The desktop app connected to another computer as its client. */
  remote: boolean;
  /** A Team Cloud's page. */
  team: boolean;
  /** This person may change this place's settings. */
  canSave: boolean;
  /** A sponsor's card may reach this person (src/lib/announcements.ts SPONSOR_CARDS_FOR_TEAM_MEMBERS). */
  sponsors: boolean;
  /** ModelGo may be offered here (src/lib/modelgo-offer.ts modelgoOfferable). */
  modelgo: boolean;
}

export type HistoryMark = "teams" | "cloud" | "boat" | "modelgo" | "grok" | "product-hunt";
/** A popup the Announcements page opens again. */
export type HistoryModal = "teams" | "whats-new" | "grok-move";
export type HistoryAction = { open_url: string } | { email: string } | { cloud_add: CloudSource } | { cloud_how_to: true };
export interface HistoryButton { label: LocaleKey; action: HistoryAction }

export interface BuiltInAnnouncement {
  /** Its notice id (src/lib/notices.ts), which also keeps whether the person saw it. */
  id: string;
  /** When it first reached people: an ISO date (UTC midnight) or date and time. */
  date: string;
  title: LocaleKey;
  body: LocaleKey;
  mark: HistoryMark;
  for(facts: HistoryFacts): boolean;
  /** A popup opens again; a card shows its buttons, the first one primary. */
  open: { modal: HistoryModal } | { buttons: readonly HistoryButton[] };
  /** An offer's end (epoch ms): after it, Ended in place of its buttons. */
  until?: number | null;
}

const everywhere = (facts: HistoryFacts) => !facts.branded && facts.organization === false;

export const BUILT_IN_ANNOUNCEMENTS: readonly BuiltInAnnouncement[] = [
  { id: TEAMS_NOTICE, date: "2026-11-17", title: "teamsNew.title", body: "teamsNew.sharedBot", mark: "teams", for: everywhere, open: { modal: "teams" } },
  { id: MODELGO_OFFER_NOTICE, date: "2026-11-11", title: "modelgoOffer.title", body: "modelgoOffer.line", mark: "modelgo", for: facts => facts.sponsors && facts.modelgo && !facts.branded,
    open: { buttons: [{ label: "modelgoOffer.getKey", action: { open_url: MODELGO_URL } }] } },
  { id: GROK_MOVE_NOTICE, date: "2026-11-04", title: "settings.import.grokTitle", body: "grokMove.popup.body", mark: "grok",
    for: facts => everywhere(facts) && !facts.remote && facts.canSave && !facts.team, open: { modal: "grok-move" } },
  { id: WHATS_NEW_NOTICE, date: "2026-10-31", title: "whatsNew.cloud.title", body: "whatsNew.cloud.body", mark: "cloud",
    for: facts => everywhere(facts) && facts.cloudSale, open: { modal: "whats-new" } },
  { id: BOAT_OFFER_NOTICE, date: "2026-10-31", title: "boatOffer.title", body: "boatOffer.body", mark: "boat", for: facts => facts.sponsors && !facts.branded,
    open: { buttons: [{ label: "boatOffer.get", action: { open_url: BOAT_OFFER.url } }, { label: "boatOffer.claim", action: { email: boatClaimMailto() } }] }, until: BOAT_OFFER.until },
  { id: PRODUCT_HUNT_NOTICE, date: "2026-10-13", title: "productHunt.title", body: "productHunt.body", mark: "product-hunt",
    for: facts => everywhere(facts) && facts.cloudCards, open: { buttons: [{ label: "productHunt.button", action: { open_url: PRODUCT_HUNT_URL } }] }, until: PRODUCT_HUNT_UNTIL },
  { id: CLOUD_INTRO, date: "2026-10-09", title: "cloudIntro.title", body: "cloudIntro.body", mark: "cloud", for: facts => everywhere(facts) && facts.cloudSale,
    open: { buttons: [{ label: "cloudIntro.start", action: { cloud_add: "app_card" } }, { label: "cloudIntro.howTo", action: { cloud_how_to: true } }] } },
];

/** Where the person stands before they ever open Announcements: everything up to the newest announcement before Teams
 * counts as read, so only Teams raises the dot for people who used the app before it. */
export const READ_BASELINE = Date.parse("2026-11-11");

export type HistoryItem =
  | { source: "built-in"; id: string; at: number; entry: BuiltInAnnouncement; ended: boolean }
  | { source: "feed"; id: string; at: number; card: AnnouncementCard }
  /** What a release brought (announcements/releases.json); `pending` for a downloaded update the file does not list yet. */
  | { source: "release"; id: string; at: number; release: ReleaseEntry; pending?: true };

const releaseItem = (release: ReleaseEntry, at = Date.parse(release.date)): Extract<HistoryItem, { source: "release" }> =>
  ({ source: "release", id: `release-${release.version}`, at, release });

/** Newest first; a feed card is dated by its `starts`, else by when its file last changed, else now; a release by its
 * date. A branded build lists no releases, as it has none of the built-in announcements. */
export function announcementHistory({ facts, cards, feedUpdatedAt, now, releases = [] }: {
  facts: HistoryFacts; cards: readonly AnnouncementCard[]; feedUpdatedAt: number | null; now: number; releases?: readonly ReleaseEntry[];
}): HistoryItem[] {
  const builtIn: HistoryItem[] = BUILT_IN_ANNOUNCEMENTS.filter(entry => entry.for(facts)).map(entry => ({
    source: "built-in", id: entry.id, at: Date.parse(entry.date), entry, ended: typeof entry.until === "number" && now >= entry.until,
  }));
  const feed: HistoryItem[] = cards.map(card => ({ source: "feed", id: card.id, at: card.starts ? Date.parse(card.starts) : feedUpdatedAt ?? now, card }));
  const notes: HistoryItem[] = facts.branded ? [] : releases.map(release => releaseItem(release));
  return [...builtIn, ...feed, ...notes].map((item, order) => ({ item, order })).sort((a, b) => b.item.at - a.item.at || a.order - b.order).map(({ item }) => item);
}

/** An update downloaded and waiting for a restart: its row, from its own notes (`notes`, as an entry) when the list
 * does not have it yet, goes on top. Nothing in a branded build. */
export function withDownloadedUpdate(items: readonly HistoryItem[], update: { version: string; notes: ReleaseEntry } | null, branded: boolean,
  now: number): readonly HistoryItem[] {
  if (!update || branded || items.some(item => item.source === "release" && item.release.version === update.version)) return items;
  const top = Math.max(now, ...items.map(item => item.at));
  return [{ ...releaseItem(update.notes, top), pending: true }, ...items];
}

// ---- When the person last opened Announcements: this browser, this desktop's record for every page of its window, and
// the place's record (on a Team Cloud, the person's own). The newest of them counts.

const READ_KEY = "omb.announcements.read-at";
const FIRST_VERSION_KEY = "omb.announcements.first-version";
const stored = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };

let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Re-renders when this page records something here (localStorage does not tell it). */
export function useAnnouncementRecord(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export const readMark = (at: number) => `announcements-read-${Math.floor(at)}`;

export interface PersonRecord {
  record: OnboardingStatus | undefined;
  /** This desktop's record (DesktopNoticesState.seen); empty in a browser. */
  desktopSeen: readonly string[];
  /** The app version this browser first listed announcements on (firstListedVersion): only releases after it are new. */
  firstVersion?: string | null;
}

/** The app version this browser first listed announcements on, kept from the first time; `current` when nothing can be
 * kept. So a new install, or a new browser on a Cloud, is not told about every release before it. */
export function firstListedVersion(current: string): string {
  const kept = stored(FIRST_VERSION_KEY);
  if (kept && compareVersions(kept, kept) === 0) return kept;
  if (compareVersions(current, current) === 0) store(FIRST_VERSION_KEY, current);
  return current;
}

export function announcementsReadAt({ record, desktopSeen }: PersonRecord): number {
  const local = Number(stored(READ_KEY));
  const marks = [Number.isSafeInteger(local) && local > 0 ? local : null, readMarkOf(record?.hintsSeen ?? []), readMarkOf(desktopSeen)].filter((at): at is number => at !== null);
  return marks.length ? Math.max(...marks) : READ_BASELINE;
}

export function itemSeen(item: HistoryItem, { record, desktopSeen }: PersonRecord): boolean {
  if (item.source === "release") return false;
  const key = item.source === "feed" ? `announcement:${item.id}` : item.id;
  return noticeSeen(record, key) || desktopSeen.includes(key);
}

/** A release counts for the dot only when it is after the version this browser first listed announcements on; a
 * downloaded update's own row never does (it is dated now). */
function releaseCounts(item: HistoryItem, person: PersonRecord): boolean {
  if (item.source !== "release") return true;
  if (item.pending || !person.firstVersion) return false;
  return (compareVersions(item.release.version, person.firstVersion) ?? 0) > 0;
}

/** The dot: something here is newer than the person's last look and they have not seen it. */
export function announcementsUnread(items: readonly HistoryItem[], person: PersonRecord): boolean {
  const readAt = announcementsReadAt(person);
  return items.some(item => item.at > readAt && !itemSeen(item, person) && releaseCounts(item, person));
}

export interface RecordWriter {
  /** A Team Cloud's page: the person's own record (PUT /api/me/welcome), as members cannot change the team's. */
  team: boolean;
  desktop?: { seen(id: string): Promise<void> };
  /** The place's new record, once saved. */
  saved: (config: ConfigStatus) => void;
}

function savePersonal(hint: string, hintsSeen: string[] | null, writer: RecordWriter): void {
  void writer.desktop?.seen(hint).catch(() => {});
  const saving = writer.team
    ? api("/api/me/welcome", { method: "PUT", body: JSON.stringify({ hints: [hint] }) }).then(() => api<ConfigStatus>("/api/config"))
    : hintsSeen ? api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen } }) }) : null;
  void saving?.then(writer.saved).catch(() => {});
}

/** The person opened Announcements now: the dot goes, here and on their other pages. */
export function markAnnouncementsRead(now: number, record: OnboardingStatus | undefined, writer: RecordWriter): void {
  const mark = readMark(now), hints = record?.hintsSeen ?? [];
  store(READ_KEY, String(Math.floor(now)));
  const next = [...hints.filter(hint => !ANNOUNCEMENTS_READ_HINT.test(hint)), mark];
  savePersonal(mark, next.length > 100 ? null : next, writer);
  changed();
}

/** The person closed (or used) a built-in popup that is theirs alone, as the Teams one is on a Team Cloud. */
export function rememberNoticeSeen(id: string, record: OnboardingStatus | undefined, writer: RecordWriter): void {
  const patch = dismissNotice(record, id);
  savePersonal(id, writer.team ? [] : patch?.onboarding.hintsSeen ?? null, writer);
  changed();
}

