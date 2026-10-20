import { useSyncExternalStore } from "react";
import type { OneWorkspaceBridge, OneWorkspaceView, RosterBot, RosterRoom, SideState, WorkspaceSide } from "../../shared/one-workspace";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionName } from "./sidebar-layout";

export const VIEW_REFRESH_MS = 10_000;
const ERROR_SHOWN_MS = 8_000;
const OPENING_GIVES_UP_MS = 45_000;

export type { RosterBot, RosterRoom, WorkspaceSide };

/** Where a row's bot or room lives, and whether the other side has a copy with the same id. */
export interface Home {
  side: WorkspaceSide;
  twin: boolean;
}

/** What the copy out of sight has that the copy its row opens lacks, on `side`: conversations of its own (chats from a
 * phone, its routines' and webhooks' reports), messages only it has in conversations both have, whether any of that
 * is unread, the conversation to open for it, and its switched-on automations. */
export interface TwinWork {
  side: WorkspaceSide;
  chats: number;
  unshared: number;
  unread: boolean;
  automations: number;
  threadId?: string;
}

type Conversations = { threadId?: string; tasks?: ReadonlyArray<{ threadId: string; archivedAt?: number; unread?: boolean }> };

/** A bot's open conversations, newest first. */
export function threadsOf(bot: Conversations): string[] {
  const open = (bot.tasks ?? []).filter((task) => task.archivedAt === undefined).map((task) => task.threadId);
  return [...new Set([...(bot.threadId ? [bot.threadId] : []), ...open])];
}

/** `unshared`: per conversation both copies have, how many messages only the copy out of sight has. */
export function ownWork(hidden: { threads?: readonly string[]; unreadThreads?: readonly string[]; automations?: number }, shownThreads: readonly string[], side: WorkspaceSide,
  unshared: ReadonlyMap<string, number> = new Map()): TwinWork | null {
  const shown = new Set(shownThreads);
  const own = (hidden.threads ?? []).filter((id) => !shown.has(id));
  const ahead = (hidden.threads ?? []).filter((id) => shown.has(id) && (unshared.get(id) ?? 0) > 0);
  const automations = hidden.automations ?? 0;
  if (!own.length && !ahead.length && !automations) return null;
  const threadId = (hidden.threads ?? []).find((id) => own.includes(id) || ahead.includes(id));
  return {
    side, chats: own.length, unshared: ahead.reduce((sum, id) => sum + (unshared.get(id) ?? 0), 0),
    unread: (hidden.unreadThreads ?? []).some((id) => own.includes(id) || ahead.includes(id)), automations, ...(threadId ? { threadId } : {}),
  };
}

/** The one rule for a bot or room both sides have (Send keeps its id): its row opens its home, on either page. The
 * home is this computer, where Send copied it from, unless the bots were moved to My Cloud (`twinHome`). True when
 * `id` is on both sides and this page holds the copy out of sight. */
export function awayFromHome(view: OneWorkspaceView | null, id: string): boolean {
  if (!view || view.twinHome === view.page) return false;
  return view.other.bots.some((bot) => bot.id === id) || view.other.rooms.some((room) => room.id === id);
}

/** Per conversation of one bot, how many messages only its copy on `side` has. */
export function unsharedOn(view: OneWorkspaceView, id: string, side: WorkspaceSide): Map<string, number> {
  return new Map((view.unshared?.[id] ?? []).map((entry) => [entry.threadId, entry[side]]));
}

/** One page's own bots and rooms (its store) beside the other side's, each id once. */
export interface MergedWorkspace {
  page: WorkspaceSide;
  other: WorkspaceSide;
  cloudName: string;
  state: SideState;
  reason?: string;
  /** This page's own ids whose row is their home copy on the other side. */
  hidden: ReadonlySet<string>;
  /** The other side's bots and rooms that show here. */
  bots: RosterBot[];
  rooms: RosterRoom[];
  homes: ReadonlyMap<string, Home>;
  /** For a bot both sides have: what its copy out of sight has that its home copy lacks, when it has anything. */
  twinWork: ReadonlyMap<string, TwinWork>;
  /** The copy out of sight this page has open anyway (a notification, a search, a routine run), and its conversation
   * when the home copy has it too: its row opens the home there. */
  opened?: { id: string; threadId?: string };
  /** Teams only the other side has, in its order. */
  sections: string[];
  /** Every team to list, the same on both pages: this computer's in its order, then My Cloud's own. */
  teams: string[];
}

interface HereSide {
  /** Until this page's own store has loaded, nothing is merged: a bot both sides have would show as its other copy. */
  hydrated?: boolean;
  bots: ReadonlyArray<{ id: string; hidden?: boolean; section?: string } & Conversations>;
  /** This page's switched-on routines and webhooks per bot. */
  automations?: ReadonlyMap<string, number>;
  groups: ReadonlyArray<{ id: string; dm?: boolean; section?: string }>;
  sections?: readonly string[];
  selectedId?: string | null;
}

/** Every id shows once: a bot or room both sides have shows as its home copy (`awayFromHome`), whichever page this is. */
export function mergeWorkspace(view: OneWorkspaceView, here: HereSide): MergedWorkspace {
  const page = view.page, other = view.other.side;
  const mine = new Set([...here.bots.filter((bot) => !bot.hidden).map((bot) => bot.id), ...here.groups.filter((group) => !group.dm).map((group) => group.id)]);
  const theirs = new Set([...view.other.bots.map((bot) => bot.id), ...view.other.rooms.map((room) => room.id)]);
  const hidden = new Set<string>();
  const homes = new Map<string, Home>();
  const shownThere = <T extends { id: string }>(items: readonly T[]) => items.filter((item) => {
    if (!mine.has(item.id)) {
      homes.set(item.id, { side: other, twin: false });
      return true;
    }
    if (!awayFromHome(view, item.id)) return false;
    hidden.add(item.id);
    homes.set(item.id, { side: other, twin: true });
    return true;
  });
  const bots = shownThere(view.other.bots);
  const rooms = shownThere(view.other.rooms);
  for (const id of mine) if (!hidden.has(id)) homes.set(id, { side: page, twin: theirs.has(id) });
  const twinWork = new Map<string, TwinWork>();
  for (const theirBot of view.other.bots) {
    const ownBot = here.bots.find((bot) => bot.id === theirBot.id && !bot.hidden);
    if (!ownBot) continue;
    const ownThreads = threadsOf(ownBot);
    const work = hidden.has(theirBot.id)
      ? ownWork({ threads: ownThreads, unreadThreads: (ownBot.tasks ?? []).filter((task) => task.unread && task.archivedAt === undefined).map((task) => task.threadId), automations: here.automations?.get(ownBot.id) },
        theirBot.threads ?? [], page, unsharedOn(view, theirBot.id, page))
      : ownWork(theirBot, ownThreads, other, unsharedOn(view, theirBot.id, other));
    if (work) twinWork.set(theirBot.id, work);
  }
  const openedId = here.selectedId && hidden.has(here.selectedId) ? here.selectedId : null;
  const openedThread = openedId ? here.bots.find((bot) => bot.id === openedId)?.threadId : undefined;
  const opened = openedId ? { id: openedId, ...(openedThread && view.other.bots.find((bot) => bot.id === openedId)?.threads?.includes(openedThread) ? { threadId: openedThread } : {}) } : undefined;
  const known = new Set([...(here.sections ?? []), ...here.bots.flatMap((bot) => bot.section ? [bot.section] : []), ...here.groups.flatMap((group) => group.section ? [group.section] : [])].map((name) => name.trim()));
  const sections = [...new Set([...view.other.sections, ...bots.flatMap((bot) => bot.section ? [bot.section] : []), ...rooms.flatMap((room) => room.section ? [room.section] : [])])]
    .filter((name) => !known.has(name.trim()) && [...bots, ...rooms].some((item) => item.section === name));
  const mineTeams = here.sections ?? [];
  const [computerTeams, cloudTeams] = page === "computer" ? [mineTeams, view.other.sections] : [view.other.sections, mineTeams];
  const teams = [...new Set([...computerTeams, ...cloudTeams])].filter((name) => mineTeams.includes(name) || sections.includes(name));
  return { page, other, cloudName: view.cloudName, state: view.other.state, ...(view.other.reason ? { reason: view.other.reason } : {}), hidden, bots, rooms, homes, twinWork,
    ...(opened ? { opened } : {}), sections, teams };
}

/** Of a page's own bots, the one a welcome greets: a Chief at home here, else any bot at home here, else (when every
 * bot here is a copy of one whose home is elsewhere) that home's, which `elsewhere` opens on its own side. */
export function greetedBot<T extends { id: string; chiefOfStaff?: boolean }>(bots: readonly T[], away: (id: string) => boolean): { bot: T | null; elsewhere: boolean } {
  const atHome = bots.filter((bot) => !away(bot.id));
  const pick = (from: readonly T[]) => from.find((bot) => bot.chiefOfStaff) ?? from[0] ?? null;
  const home = pick(atHome);
  if (home) return { bot: home, elsewhere: false };
  const bot = pick(bots);
  return { bot, elsewhere: Boolean(bot) };
}

/** The other side's rows a sidebar section holds: a team's by name, else the built-in Bots and Channels sections. */
export function otherSideIn(merged: MergedWorkspace | null, sectionId: string): { bots: RosterBot[]; rooms: RosterRoom[] } {
  if (!merged) return { bots: [], rooms: [] };
  const name = userSectionName(sectionId);
  if (name) {
    const bots = merged.bots.filter((bot) => bot.section === name);
    return { bots: [...bots.filter((bot) => bot.chiefOfStaff), ...bots.filter((bot) => !bot.chiefOfStaff)], rooms: merged.rooms.filter((room) => room.section === name) };
  }
  if (sectionId === BOTS_SECTION_ID) return { bots: merged.bots.filter((bot) => !bot.section), rooms: [] };
  if (sectionId === CHANNELS_SECTION_ID) return { bots: [], rooms: merged.rooms.filter((room) => !room.section) };
  return { bots: [], rooms: [] };
}

/** The built-in sections the other side's rows need, beyond the teams it adds. */
export function otherSideNeeds(merged: MergedWorkspace | null): { bots: boolean; channels: boolean } {
  return { bots: Boolean(merged?.bots.some((bot) => !bot.section)), channels: Boolean(merged?.rooms.some((room) => !room.section)) };
}

/** The other side's rows a sidebar search keeps; its `sections` are every team those rows sit in, so a match in a team
 * both sides have still shows when this page has no match there. */
export function searchMerged(merged: MergedWorkspace | null, query: string): MergedWorkspace | null {
  const q = query.trim().toLowerCase();
  if (!merged || !q) return merged;
  const bots = merged.bots.filter((bot) => bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q));
  const rooms = merged.rooms.filter((room) => room.name.toLowerCase().includes(q));
  return { ...merged, bots, rooms, sections: [...new Set([...bots, ...rooms].flatMap((item) => item.section ? [item.section] : []))] };
}

export function oneWorkspaceBridge(): OneWorkspaceBridge | undefined {
  if (typeof window === "undefined" || window.ogb?.remoteClient?.active) return undefined;
  return window.ogb?.oneWorkspace;
}

export interface OneWorkspaceSnapshot {
  view: OneWorkspaceView | null;
  /** A row of the other side the person opened, while the window moves there. */
  opening: { side: WorkspaceSide; id: string } | null;
  error: string | null;
}

const EMPTY: OneWorkspaceSnapshot = { view: null, opening: null, error: null };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function publish(patch: Partial<OneWorkspaceSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of Array.from(listeners)) listener();
}

function watch(bridge: OneWorkspaceBridge): () => void {
  let live = true;
  const refresh = () => { void bridge.view().then((view) => { if (live) publish({ view }); }, () => {}); };
  const off = bridge.onView((view) => { if (live) publish({ view }); });
  const whenVisible = () => { if (document.visibilityState === "visible") refresh(); };
  refresh();
  const timer = window.setInterval(whenVisible, VIEW_REFRESH_MS);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", whenVisible);
  return () => {
    live = false;
    off();
    window.clearInterval(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", whenVisible);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !stopWatching) {
    const bridge = oneWorkspaceBridge();
    if (bridge) stopWatching = watch(bridge);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}

const read = () => snapshot;

/** Main's view of the other side, kept current while anything shows it; null while the two are shown apart. */
export function useOneWorkspace(): OneWorkspaceSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** The last answer for the same arguments (compared by identity), so every render of the same store and view shares one. */
export function lastOf<A extends unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; result: R } | null = null;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((value, index) => Object.is(value, args[index]))) return last.result;
    last = { args, result: compute(...args) };
    return last.result;
  };
}

const merged = lastOf((view: OneWorkspaceView | null, bots: HereSide["bots"], groups: HereSide["groups"], sections: HereSide["sections"], selectedId: HereSide["selectedId"], automations: HereSide["automations"]) =>
  view ? mergeWorkspace(view, { bots, groups, sections, selectedId, automations }) : null);

/** This page's store merged with the other side; null while the two are shown apart. */
export function useMergedWorkspace(here: HereSide): MergedWorkspace | null {
  const { view } = useOneWorkspace();
  return merged(here.hydrated === false ? null : view, here.bots, here.groups, here.sections, here.selectedId, here.automations);
}

/** A row of this page's own: its home is this page's side; `twin` when the other side has it too. */
/** The switched-on routines and webhooks of each bot in this page's own store. */
export const automationsByBot = lastOf((routines: ReadonlyArray<{ botId: string; enabled: boolean }>, webhooks: ReadonlyArray<{ botId: string; enabled: boolean }>) => {
  const counts = new Map<string, number>();
  for (const item of [...routines, ...webhooks]) if (item.enabled) counts.set(item.botId, (counts.get(item.botId) ?? 0) + 1);
  return counts;
});

/** For a row of this page's own that shows: what its copy on the other side has that this one lacks, if anything. */
export function useTwinWork(bot: { id: string } & Conversations): TwinWork | null {
  const { view } = useOneWorkspace();
  const theirs = view?.other.bots.find((entry) => entry.id === bot.id);
  return view && theirs ? ownWork(theirs, threadsOf(bot), view.other.side, unsharedOn(view, bot.id, view.other.side)) : null;
}

export function useOwnHome(id: string): Home | null {
  const key = useSyncExternalStore(subscribe, () => ownHomeKey(snapshot.view, id), () => ownHomeKey(snapshot.view, id));
  if (!key) return null;
  const [side, twin] = key.split(":");
  return { side: side as WorkspaceSide, twin: twin === "1" };
}

function ownHomeKey(view: OneWorkspaceView | null, id: string): string | null {
  if (!view) return null;
  const twin = view.other.bots.some((bot) => bot.id === id) || view.other.rooms.some((room) => room.id === id);
  return `${view.page}:${twin ? 1 : 0}`;
}

/** Shows a bot or room of the other side there (at one of its own conversations, `threadId`): main moves the window and
 * that side's page opens it. */
export async function openElsewhere(target: { side: WorkspaceSide; id: string; threadId?: string }): Promise<void> {
  const bridge = oneWorkspaceBridge();
  if (!bridge || snapshot.opening) return;
  publish({ opening: target, error: null });
  const giveUp = window.setTimeout(() => { if (snapshot.opening === target) publish({ opening: null }); }, OPENING_GIVES_UP_MS);
  try {
    await bridge.open(target);
  } catch (error) {
    window.clearTimeout(giveUp);
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "") : String(error);
    publish({ opening: null, error: message });
    window.setTimeout(() => { if (snapshot.error === message) publish({ error: null }); }, ERROR_SHOWN_MS);
  }
}

export function setOneWorkspaceForTests(next: Partial<OneWorkspaceSnapshot> | null): void {
  snapshot = next ? { ...EMPTY, ...next } : EMPTY;
  for (const listener of Array.from(listeners)) listener();
}
