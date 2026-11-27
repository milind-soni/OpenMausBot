// One list of bots: with "This computer and My Cloud together" on (electron/places-together.mjs), the other place's bots
// sit among this page's own, in its departments and order (src/lib/one-list.ts lays them out). A row of the other place
// becomes a Bot-shaped value the sidebar places and draws like any other. Its id is its place's key and its own id
// (`cloud:scout`), so two bots with one id in two places never meet, and nothing that writes to this place's server is
// ever handed one: what such a row sends is either "open it", which main does where the bot lives, or dropped.
//
// Both pages draw it, the same way: this computer's page, and My Cloud's own page, which lists this computer's bots.
//
// Everything here is keyed by a place, not by "My Cloud": today the places are this computer and My Cloud, and a
// person's own always-on machine (a server of their own, or a computer at home) is meant to join the same list later
// as one more place, with its own key, kind, name and state.
import type { Dispatch } from "react";
import { BOT_BODY_IDS, type BotBodyId } from "../../shared/bot-body";
import { MASCOT_FACE_COLORS, mascotBodyColorSchema, mascotMaterialSchema, type MascotFaceColor } from "../../shared/bot-avatar";
import type { Action, Bot } from "@/state/store";
import { citationPreviewText } from "./citations";
import { t } from "./i18n";
import { localizedTaskTitle } from "./task-title";
import { plainPreviewText } from "../../shared/plain-preview";
import { MAUS_COLOR_NAMES, type MausColor } from "./mascot";
import { openOtherPlaceBot, usePlacesTogetherPart, type BotHome, type PlaceBotRow, type PlacesTogetherState } from "./places-together";
import { openPlaceBot } from "./place-chat";

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
    // Its department there: the one list draws a bot of the home place in it on the other page too.
    ...(row.section ? { section: row.section } : {}),
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

/** The one list is on for this page: the switch is on and main lists the other place. On My Cloud's page only from an
 * app that says which place is home (and keeps where bots are moved): with an older one, that page lists its own bots
 * only, as it did before. */
export const oneListOn = (state: PlacesTogetherState | null): boolean => state?.on === true && state.other !== null && (state.here === "computer" || state.home !== undefined);

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
export function useOtherPlaceBots(query: string): readonly PlacedBot[] {
  const all = usePlacesTogetherPart(placedList);
  if (!query || !all.length) return all;
  if (lastSearch.all !== all || lastSearch.query !== query) {
    lastSearch = { all, query, found: all.filter((bot) => bot.name.toLowerCase().includes(query) || bot.title.toLowerCase().includes(query)) };
  }
  return lastSearch.found;
}
/** The last search's rows, kept while the list and the words stay the same (no hook: the sidebar calls this on every draw). */
let lastSearch: { all: readonly PlacedBot[]; query: string; found: readonly PlacedBot[] } = { all: NONE, query: "", found: NONE };

const openers = new Map<string, { store: Dispatch<Action> | undefined; opener: Dispatch<Action> }>();

/** What a row of the other place does with what its row would send this place's store: choosing it opens its bot, once
 * per click or key. A My Cloud bot on this computer's page opens right here, in this window (src/lib/place-chat.ts:
 * `store` is this page's store); anywhere else, or when that can't be done, main switches the window to the place it
 * lives in, as before. Renaming, a folder or anything else is not for this place and is dropped. */
export function otherPlaceDispatch(bot: PlacedBot, store?: Dispatch<Action>): Dispatch<Action> {
  const had = openers.get(bot.id);
  if (had && had.store === store) return had.opener;
  const { id, place } = bot.placedFrom;
  let opening = false;
  const opener: Dispatch<Action> = (action) => {
    if ((action.type !== "select" && action.type !== "switchTask") || opening) return;
    opening = true;
    queueMicrotask(() => { opening = false; });
    if (store && place.kind === "my-cloud") void openPlaceBot(id, store);
    else openOtherPlaceBot(id);
  };
  openers.set(bot.id, { store, opener });
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

/** This page's place while the one list is on; null while it is off, in a browser, and on any other place's page. */
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
  openers.clear();
}
