// Where each bot in the one list lives, and where it is working right now: the small device mark a row shows. Design
// preview only (unified-sidebar-preview.html): the words are English here and move to the locale files, with pt-br,
// in the real change. A row asks by its bot's id; nothing here reads a server.
import { useSyncExternalStore } from "react";

/** The shape of the machine, for its icon: the person's own computers by kind, and My Cloud. */
export type PlaceDevice = "laptop" | "desktop" | "server" | "cloud";
/** How a place is doing, as main last heard it. Asleep is normal for a Cloud and never an error. */
export type PlaceHealth = "ready" | "asleep" | "waking" | "offline";

export interface Place {
  /** The place's own stable id (its environment id), never its address. */
  key: string;
  device: PlaceDevice;
  /** "This computer", "My Cloud", or the name the person gave another computer. */
  name: string;
  health: PlaceHealth;
  /** This is the computer the app runs on. */
  here?: boolean;
}

export interface BotWhere {
  home: Place;
  /** Where its current work runs, when that is not its home: a hand-off to a bot there, or a lent computer. */
  workingAt?: Place;
  /** A step of its work waits for this computer to come back. */
  waitingFor?: Place;
  /** The bot is working right now. */
  working?: boolean;
}

export type PlaceIcon = "laptop" | "desktop" | "server" | "cloud" | "cloud-asleep" | "cloud-waking" | "cloud-off" | "computer-off";

export interface PlaceMark {
  icon: PlaceIcon;
  /** The tooltip and the screen reader's words. */
  label: string;
  /** "always" while it says something the row does not (working, asleep, off, waiting); "hover" otherwise. */
  shows: "always" | "hover";
}

const WORDS = {
  livesHere: "Lives on this computer",
  livesOn: "Lives on {place}",
  workingOn: "Working on {place} now",
  workingHere: "Working on this computer now",
  asleep: "{place} is asleep. Opening {bot} wakes it.",
  waking: "{place} is waking up",
  offlineCloud: "{place} can't be reached right now. {bot} carries on when it's back.",
  offlineComputer: "{place} is off or asleep. {bot} opens when it's back.",
  waitingFor: "Waiting for {place} to come back",
};
const say = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

const deviceIcon = (place: Place): PlaceIcon => place.device;

/** The mark for one bot. Pure: the row draws it, and tests read it. */
export function placeMark(bot: { name: string }, where: BotWhere): PlaceMark {
  const { home } = where;
  const values = { bot: bot.name, place: home.name };
  if (where.waitingFor) return { icon: where.waitingFor.device === "cloud" ? "cloud-off" : "computer-off", label: say(WORDS.waitingFor, { place: where.waitingFor.name }), shows: "always" };
  if (home.health === "offline") return { icon: home.device === "cloud" ? "cloud-off" : "computer-off", label: say(home.device === "cloud" ? WORDS.offlineCloud : WORDS.offlineComputer, values), shows: "always" };
  if (home.device === "cloud" && home.health === "asleep") return { icon: "cloud-asleep", label: say(WORDS.asleep, values), shows: "always" };
  if (home.device === "cloud" && home.health === "waking") return { icon: "cloud-waking", label: say(WORDS.waking, values), shows: "always" };
  if (where.workingAt) return { icon: deviceIcon(where.workingAt), label: where.workingAt.here ? WORDS.workingHere : say(WORDS.workingOn, { place: where.workingAt.name }), shows: "always" };
  if (where.working) return { icon: deviceIcon(home), label: home.here ? WORDS.workingHere : say(WORDS.workingOn, values), shows: "always" };
  return { icon: deviceIcon(home), label: home.here ? WORDS.livesHere : say(WORDS.livesOn, values), shows: "hover" };
}

let known = new Map<string, BotWhere>();
let variant: "hover" | "faint" = "hover";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The preview's word for every bot's place. Null: the one list is off, and rows show no mark. */
export function setBotPlaces(next: Map<string, BotWhere> | null, how: "hover" | "faint" = "hover"): void {
  known = next ?? new Map();
  variant = how;
  for (const listener of listeners) listener();
}

export function useBotWhere(botId: string): BotWhere | null {
  return useSyncExternalStore(subscribe, () => known.get(botId) ?? null, () => null);
}

/** Icon on hover only, or a faint icon on every row that darkens on hover. */
export function usePlaceMarkVariant(): "hover" | "faint" {
  return useSyncExternalStore(subscribe, () => variant, () => "hover");
}

/** The one list is on: rows carry places. */
export function useBotPlaces(): boolean {
  return useSyncExternalStore(subscribe, () => known.size > 0, () => false);
}
