// One list of bots: with "This computer and My Cloud together" on (electron/places-together.mjs), the other place's bots
// sit among this page's own, in the same list, Unread and order, instead of in a group of their own. A row of the other
// place becomes a Bot-shaped value the sidebar places and draws like any other. Its id is its place's key and its own id
// (`cloud:scout`), so two bots with one id in two places never meet, and nothing that writes to this place's server is
// ever handed one: what such a row sends is either "open it", which main does where the bot lives, or dropped.
//
// The one list is this computer's page's: the page the rail's first circle opens. My Cloud's page, opened from its own
// circle, lists My Cloud's bots only, as it does with the switch off, so the rail still shows the Cloud on its own.
//
// Everything here is keyed by a place, not by "My Cloud": today the places are this computer and My Cloud, and a
// person's own always-on machine (a server of their own, or a computer at home) is meant to join the same list later
// as one more place, with its own key, kind, name and state.
import { useEffect, useSyncExternalStore, type Dispatch, type RefObject } from "react";
import { BOT_BODY_IDS, type BotBodyId } from "../../shared/bot-body";
import { MASCOT_FACE_COLORS, mascotBodyColorSchema, mascotMaterialSchema, type MascotFaceColor } from "../../shared/bot-avatar";
import type { Action, Bot } from "@/state/store";
import { citationPreviewText } from "./citations";
import { t } from "./i18n";
import { localizedTaskTitle } from "./task-title";
import { plainPreviewText } from "../../shared/plain-preview";
import { MAUS_COLOR_NAMES, type MausColor } from "./mascot";
import { openOtherPlaceBot, usePlacesTogetherPart, type BotHome, type PlaceBotRow, type PlacesTogetherState } from "./places-together";

/** How a place is doing, as main last said. Asleep and waking are normal for a Cloud, never an error. */
export type PlaceHealth = NonNullable<PlacesTogetherState["other"]>["state"];

/** What kind of machine a place is: its icon, and its words where it has words of its own. */
export type PlaceKind = "this-computer" | "my-cloud" | "own-server" | "home-computer";

/** A place in the one list: its stable key (the namespace of its bots' ids, never an address), its kind and its name. */
export interface Place {
  key: string;
  kind: PlaceKind;
  label: string;
}

/** The two places main lists today, as places. */
export function placeOfHome(home: BotHome): Place {
  return home === "cloud" ? { key: "cloud", kind: "my-cloud", label: t("cloudSetup.myCloud") } : { key: "computer", kind: "this-computer", label: t("place.local") };
}

/** A bot's key in a list that holds several places: ids are unique only within one. */
export const placeKeyed = (place: Pick<Place, "key">, id: string): string => `${place.key}:${id}`;

/** Where a row of the other place comes from: its place, its own id there, how that place is doing, its preview and the
 * title of the conversation it has open there. */
export interface PlacedFrom {
  place: Place;
  id: string;
  health: PlaceHealth;
  preview?: string;
  chat?: string;
}

export type PlacedBot = Bot & { placedFrom: PlacedFrom; lastAt?: number };

export function isPlacedBot(bot: object): bot is PlacedBot {
  return "placedFrom" in bot;
}

const known = <T extends string>(list: readonly string[], value: string | undefined): T | null => (value !== undefined && list.includes(value) ? value as T : null);

/** A row of the other place as a bot of this list. It carries only what the row does: a name, a look, a state, a time
 * and its preview line; never a whole message, an engine or a setting of the other place. */
export function placedBot(row: PlaceBotRow, health: PlaceHealth, place: Place = placeOfHome(row.home)): PlacedBot {
  return {
    id: placeKeyed(place, row.id), threadId: placeKeyed(place, row.threadId),
    name: row.name, title: row.title ?? "", description: "", notifications: false,
    color: known<MausColor>(MAUS_COLOR_NAMES, row.color) ?? "green",
    mascotBody: known<BotBodyId>(BOT_BODY_IDS, row.mascotBody),
    mascotFaceColor: known<MascotFaceColor>(MASCOT_FACE_COLORS, row.mascotFaceColor),
    mascotBodyColor: mascotBodyColorSchema.safeParse(row.mascotBodyColor).data ?? null,
    mascotMaterial: mascotMaterialSchema.safeParse(row.mascotMaterial).data ?? null,
    unread: row.unread === true,
    // Working is believed only while its place answers: a row kept from before My Cloud slept, or while it can't be
    // reached, is not working now as far as anyone here knows.
    ...(row.waiting ? { activity: "waiting-on-you" as const } : row.working && health === "ready" ? { busy: true, activity: "working" as const } : {}),
    // No engine of this place: no model badge, and nothing here runs it.
    modelSelection: { instanceId: "", model: "" },
    messages: [],
    placedFrom: { place, id: row.id, health, ...(row.preview ? { preview: row.preview } : {}), ...(row.chat ? { chat: row.chat } : {}) },
    ...(row.lastAt !== undefined ? { lastAt: row.lastAt } : {}),
  };
}

const sameRow = (a: PlaceBotRow, b: PlaceBotRow): boolean => {
  const keys = Object.keys(a) as Array<keyof PlaceBotRow>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** Each row's bot is kept while its row and its place's state stay the same, so a row that did not change keeps its
 * value and is not drawn again (BotListItem is memoized on its props). */
let adapted = new Map<string, { row: PlaceBotRow; health: PlaceHealth; bot: PlacedBot }>();
const NONE: readonly PlacedBot[] = Object.freeze([]);
let lastState: PlacesTogetherState | null | undefined;
let lastList: readonly PlacedBot[] = NONE;
/** The rows the other place gave last, kept while a later answer brings none only because that place is loading,
 * asleep, waking or can't be reached: a read never takes rows away to put them back. */
let lastRows: { home: BotHome; rows: PlaceBotRow[] } | null = null;

/** The one list is on for this page: the switch is on, main lists the other place, and this is this computer's page. */
export const oneListOn = (state: PlacesTogetherState | null): boolean => state?.on === true && state.other !== null && state.here === "computer";

function placedList(state: PlacesTogetherState | null): readonly PlacedBot[] {
  if (state === lastState) return lastList;
  lastState = state;
  const other = oneListOn(state) ? state!.other : null;
  const held = other && !other.bots.length && other.state !== "ready" && other.state !== "signin" && lastRows?.home === other.home ? lastRows.rows : null;
  const rows = held ?? other?.bots ?? [];
  lastRows = other ? { home: other.home, rows } : null;
  const kept = new Map<string, { row: PlaceBotRow; health: PlaceHealth; bot: PlacedBot }>();
  const next = rows.map((row) => {
    const key = placeKeyed(placeOfHome(row.home), row.id), had = adapted.get(key);
    const entry = had && had.health === other!.state && sameRow(had.row, row) ? had : { row, health: other!.state, bot: placedBot(row, other!.state) };
    kept.set(key, entry);
    return entry.bot;
  });
  adapted = kept;
  if (next.length === lastList.length && next.every((bot, index) => bot === lastList[index])) return lastList;
  lastList = next.length ? next : NONE;
  return lastList;
}

/** The other place's bots for the one list, matching the sidebar's search (`query`, already trimmed and lower case).
 * The same empty list while the switch is off, in a browser, and on any other place's page. */
export function useOtherPlaceBots(query: string, list?: RefObject<HTMLElement | null>): readonly PlacedBot[] {
  useQuietList(list);
  const answered = usePlacesTogetherPart(placedList);
  const all = useSyncExternalStore(subscribeQuiet, () => settled(answered), () => settled(answered));
  if (!query || !all.length) return all;
  if (lastSearch.all !== all || lastSearch.query !== query) {
    lastSearch = { all, query, found: all.filter((bot) => bot.name.toLowerCase().includes(query) || bot.title.toLowerCase().includes(query)) };
  }
  return lastSearch.found;
}
/** The last search's rows, kept while the list and the words stay the same (no hook: the sidebar calls this on every draw). */
let lastSearch: { all: readonly PlacedBot[]; query: string; found: readonly PlacedBot[] } = { all: NONE, query: "", found: NONE };

// Rows of the other place never push rows the person can already see. They come in after this page's own and are
// ranked (Unread, working first) only while the list is quiet: the pointer is not over it and it has not been clicked,
// typed in or scrolled for QUIET_MS. Until then a new row of the other place is listed at the end of the main list as
// a plain row, and a row that changed keeps the place it had; both take their place once the list is quiet.
export const QUIET_MS = 2_000;
const quiet = { inside: false, lastAt: -Infinity, version: 0, pending: false, timer: null as ReturnType<typeof setTimeout> | null };
const quietListeners = new Set<() => void>();
const subscribeQuiet = (listener: () => void) => { quietListeners.add(listener); return () => { quietListeners.delete(listener); }; };
const isQuiet = () => !quiet.inside && Date.now() - quiet.lastAt >= QUIET_MS;
/** What each row of the other place was last ranked by. */
let ranked = new Map<string, PlacedBot>();
const plain = new WeakMap<PlacedBot, PlacedBot>();
let lastSettled: { answered: readonly PlacedBot[]; version: number; list: readonly PlacedBot[] } | null = null;

function settleWhenQuiet(): void {
  if (quiet.timer !== null) clearTimeout(quiet.timer);
  quiet.timer = null;
  if (quiet.inside || !quiet.pending) return;
  quiet.timer = setTimeout(() => {
    quiet.timer = null;
    if (!isQuiet()) { settleWhenQuiet(); return; }
    quiet.version += 1;
    for (const listener of quietListeners) listener();
  }, Math.max(0, quiet.lastAt + QUIET_MS - Date.now()));
}

/** A row of the other place as it is ranked before its place in the list is settled: no unread, no work, no time. */
function plainRow(bot: PlacedBot): PlacedBot {
  let row = plain.get(bot);
  if (!row) { row = { ...bot, unread: false, busy: undefined, activity: undefined, lastAt: undefined }; plain.set(bot, row); }
  return row;
}

function settled(answered: readonly PlacedBot[]): readonly PlacedBot[] {
  if (lastSettled && lastSettled.answered === answered && lastSettled.version === quiet.version) return lastSettled.list;
  let list: readonly PlacedBot[];
  if (isQuiet()) {
    ranked = new Map(answered.map((bot) => [bot.id, bot]));
    quiet.pending = false;
    list = answered;
  } else {
    const next = answered.map((bot) => ranked.get(bot.id) ?? plainRow(bot));
    quiet.pending = next.some((bot, index) => bot !== answered[index]);
    const before = lastSettled?.list;
    list = before && before.length === next.length && next.every((bot, index) => bot === before[index]) ? before : next;
    settleWhenQuiet();
  }
  lastSettled = { answered, version: quiet.version, list };
  return list;
}

/** Follows the pointer and the person's clicks, keys and scrolling on the list, for QUIET_MS. */
function useQuietList(list?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = list?.current;
    if (!element) return;
    const touched = () => { quiet.lastAt = Date.now(); settleWhenQuiet(); };
    const enter = () => { quiet.inside = true; settleWhenQuiet(); };
    const leave = () => { quiet.inside = false; settleWhenQuiet(); };
    const events: Array<[string, () => void]> = [["pointerenter", enter], ["pointerleave", leave], ["pointerdown", touched], ["keydown", touched], ["wheel", touched]];
    for (const [name, handler] of events) element.addEventListener(name, handler, { passive: true });
    element.addEventListener("scroll", touched, { capture: true, passive: true });
    return () => {
      for (const [name, handler] of events) element.removeEventListener(name, handler);
      element.removeEventListener("scroll", touched, { capture: true });
      quiet.inside = false;
    };
  }, [list]);
}

/** The sidebar's parts with the other place's rows after this place's own in the main list: the busy-first order and
 * Unread then take every row the same way. Departments, pins and tiles stay this place's own. */
export function withOtherPlace<T extends { unsectionedBots: Bot[] }>(parts: T, placed: readonly PlacedBot[]): T {
  return placed.length ? { ...parts, unsectionedBots: [...parts.unsectionedBots, ...placed] } : parts;
}

/** This place's own rows only: what a drag or Alt+Up/Down arranges and saves to this place's server. */
export function ownRows<T extends object>(bots: T[]): T[] {
  return bots.some(isPlacedBot) ? bots.filter((bot) => !isPlacedBot(bot)) : bots;
}

const openers = new Map<string, Dispatch<Action>>();

/** What a row of the other place does with what its row would send this place's store: choosing it opens its bot where
 * it lives (main switches the window there, as a row of the old group did), once per click or key; renaming, a new
 * conversation, a folder or anything else is not for this place and is dropped. */
export function otherPlaceDispatch(bot: PlacedBot): Dispatch<Action> {
  const had = openers.get(bot.id);
  if (had) return had;
  const { id } = bot.placedFrom;
  let opening = false;
  const opener: Dispatch<Action> = (action) => {
    if ((action.type !== "select" && action.type !== "switchTask") || opening) return;
    opening = true;
    queueMicrotask(() => { opening = false; });
    openOtherPlaceBot(id);
  };
  openers.set(bot.id, opener);
  return opener;
}

/** A row of the other place opens no menu here. */
export const NO_MENU = (): void => {};

/** The second line of a row of the other place: the start of its newest line, in the same plain words this page's own
 * rows use, while the other place sent one; else the title of the conversation it has open there; else its role in the
 * Simple sidebar, where no role is shown, and nothing in Advanced, whose row shows the role already. */
export function placedLine(bot: PlacedBot, advanced: boolean): string {
  const { preview, chat } = bot.placedFrom;
  if (preview) return plainPreviewText(citationPreviewText(preview));
  if (chat) return localizedTaskTitle(chat);
  return advanced ? "" : bot.title;
}

export type PlaceIcon = "computer" | "cloud" | "server" | "cloud-asleep" | "cloud-waking" | "cloud-off" | "computer-off" | "server-off";

export interface PlaceMark {
  /** The place's key: which place the row's bot lives in. */
  place: string;
  kind: PlaceKind;
  icon: PlaceIcon;
  /** The tooltip, and what a screen reader says, shown or not. */
  label: string;
  /** "always" while it says something the row does not (working, asleep, waking, can't be reached); "hover" otherwise:
   * shown on hover and keyboard focus. */
  shows: "always" | "hover";
}

const DEVICE: Record<PlaceKind, { icon: PlaceIcon; off: PlaceIcon }> = {
  "this-computer": { icon: "computer", off: "computer-off" }, "home-computer": { icon: "computer", off: "computer-off" },
  "my-cloud": { icon: "cloud", off: "cloud-off" }, "own-server": { icon: "server", off: "server-off" },
};

/** The device mark for one row. Pure: the row draws it, and the tests read it. A place that is asleep or can't be
 * reached says so on its rows in quiet words, never as an error. This computer and My Cloud have words of their own;
 * any other place of the person's is named by its own name. */
export function placeMark(place: Place, health: PlaceHealth, working: boolean, name: string): PlaceMark {
  const { kind } = place, device = DEVICE[kind];
  const mark = (icon: PlaceIcon, label: string, shows: PlaceMark["shows"]): PlaceMark => ({ place: place.key, kind, icon, label, shows });
  if (kind === "my-cloud" && health === "asleep") return mark("cloud-asleep", t("together.mark.asleep", { name }), "always");
  if (kind === "my-cloud" && health === "waking") return mark("cloud-waking", t("together.state.waking"), "always");
  if (health === "offline") return mark(device.off, kind === "my-cloud" ? t("together.mark.offlineCloud", { name })
    : kind === "this-computer" ? t("together.state.offlineComputer") : t("together.mark.offline", { place: place.label, name }), "always");
  if (working) return mark(device.icon, kind === "my-cloud" ? t("together.mark.workingCloud") : kind === "this-computer" ? t("together.mark.workingComputer")
    : t("together.mark.workingOn", { place: place.label }), "always");
  return mark(device.icon, kind === "my-cloud" ? t("together.mark.livesCloud") : kind === "this-computer" ? t("together.mark.livesComputer") : t("together.mark.livesOn", { place: place.label }), "hover");
}

/** This page's place while the one list is on; null while it is off, in a browser, on My Cloud's page and on any other
 * place's page. */
const hereOf = (state: PlacesTogetherState | null): BotHome | null => (oneListOn(state) ? state!.here : null);

/** The mark a row draws, given this page's place while the one list is on (`here`, from useOneListHere once for the
 * whole list); none with it off. A row of this place lives here, and here is awake. */
export function rowPlaceMark(bot: Bot, working: boolean, here: BotHome | null | undefined): PlaceMark | null {
  if (!here) return null;
  const from = isPlacedBot(bot) ? bot.placedFrom : null;
  return from ? placeMark(from.place, from.health, working, bot.name) : placeMark(placeOfHome(here), "ready", working, bot.name);
}

/** This page's place while the one list is on, for the rows' marks; null while it is off. */
export function useOneListHere(): BotHome | null {
  return usePlacesTogetherPart(hereOf);
}

const NO_IDS: ReadonlySet<string> = new Set();
let listedIds: { list: readonly PlacedBot[]; ids: ReadonlySet<string> } = { list: NONE, ids: NO_IDS };
const listedOnMyCloud = (state: PlacesTogetherState | null): ReadonlySet<string> => {
  const list = placedList(state);
  if (listedIds.list !== list) {
    const ids = list.filter((bot) => bot.placedFrom.place.kind === "my-cloud").map((bot) => bot.placedFrom.id);
    listedIds = { list, ids: ids.length ? new Set(ids) : NO_IDS };
  }
  return listedIds.ids;
};

/** The ids, on My Cloud, of the bots its rows list in this page's one list: none with it off. */
export function useListedOnMyCloud(): ReadonlySet<string> {
  return usePlacesTogetherPart(listedOnMyCloud);
}

export function resetPlaceRowsForTest(): void {
  adapted = new Map();
  lastState = undefined;
  lastList = NONE;
  lastSearch = { all: NONE, query: "", found: NONE };
  lastRows = null;
  ranked = new Map();
  lastSettled = null;
  if (quiet.timer !== null) clearTimeout(quiet.timer);
  Object.assign(quiet, { inside: false, lastAt: -Infinity, version: 0, pending: false, timer: null });
  openers.clear();
}
