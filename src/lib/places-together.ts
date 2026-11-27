// This computer and My Cloud together (electron/places-together.mjs), as a page sees it: the other place's bots, listed
// beside its own. Every row carries its `home`, and ids are unique only within a place, so rows are keyed by home and id.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ArrangedBot, BotHome, PlaceBotRow, PlacesTogetherState } from "../../electron/places-together.mjs";

export type { ArrangedBot, BotHome, PlaceBotRow, PlacesTogetherState };

/** A bot's key in a list that holds both places: ids are unique only within one. */
export const placedKey = (home: BotHome, id: string): string => `${home}:${id}`;

/** The other place's rows that match what the person typed in the sidebar's search. */
export function matchingRows(rows: readonly PlaceBotRow[], query: string): PlaceBotRow[] {
  const wanted = query.trim().toLowerCase();
  return wanted ? rows.filter((row) => row.name.toLowerCase().includes(wanted) || (row.title ?? "").toLowerCase().includes(wanted)) : [...rows];
}

const bridge = () => (typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.placesTogether);

let known: PlacesTogetherState | null = null;
/** Main has answered at least once (or failed to): a notice waiting on it waits no longer. */
let answered = false;
let watching = 0, unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
const publish = (next: PlacesTogetherState | null) => { known = next ?? null; answered = true; for (const listener of listeners) listener(); };
const read = () => { void bridge()?.state().then(publish, () => publish(null)); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Main is asked while any component that draws its answer is on screen, and told again on focus. */
function useWatchTogether(): void {
  useEffect(() => {
    const page = bridge();
    if (!page) return;
    if (watching++ === 0) {
      unsubscribe = page.onChanged(read);
      window.addEventListener("focus", read);
      read();
    }
    return () => {
      if (--watching > 0) return;
      unsubscribe?.();
      unsubscribe = null;
      window.removeEventListener("focus", read);
    };
  }, []);
}

/** What main says about the two places: null in a browser, on another place's page, and until main first answers. */
export function usePlacesTogether(): PlacesTogetherState | null {
  useWatchTogether();
  return useSyncExternalStore(subscribe, () => known, () => null);
}

/** One part of what main says, for a component that draws only that part: it draws again only when that part changes,
 * not on every answer main gives (one each time the window is focused). `select` returns the same value for the same
 * answer: a string or number, or a value it keeps. */
export function usePlacesTogetherPart<T>(select: (state: PlacesTogetherState | null) => T): T {
  useWatchTogether();
  return useSyncExternalStore(subscribe, () => select(known), () => select(null));
}

/** Turns the switch, and says what main kept. From the notice of the default, turning it on never lends commands. */
export async function setPlacesTogether(on: boolean, from?: "notice"): Promise<void> {
  const page = bridge();
  if (page) publish(await (from ? page.set(on, from) : page.set(on)));
}

/** Whether the one-time notice that this is on by default is due on this page: null until main first answers, false in a
 * browser, on another place's page or on an older app. */
export function useTogetherNoticeDue(): boolean | null {
  const hasBridge = Boolean(bridge()?.noticeShown);
  const due = usePlacesTogetherPart((state) => (state?.notice === true ? true : answered ? false : null));
  return hasBridge ? due : false;
}

/** The notice of the default was drawn on this computer before and never closed: main still calls it due, and calls the
 * list on with no choice of the person's, which only a drawn notice does (electron/places-together.mjs). */
export function useTogetherNoticeDrawn(): boolean {
  return usePlacesTogetherPart((state) => state?.notice === true && state.on === true);
}

/** The notice was drawn: main turns the default on from now (it never does before). */
export async function togetherNoticeShown(): Promise<void> {
  const page = bridge();
  if (!page?.noticeShown) return;
  await page.noticeShown().catch(() => false);
  read();
}

/** The person closed the notice or used one of its switches: it never shows again. */
export function togetherNoticeDone(): void {
  void bridge()?.noticeDone?.().catch(() => {});
}

/** What's new showed the notice's slide: the default is on from now, as the drawn notice turns it, and the corner notice
 * never shows for this account, as when it is closed. */
export async function togetherSlideShown(): Promise<void> {
  await togetherNoticeShown();
  togetherNoticeDone();
}

/** The notice's own switch for "Let My Cloud's bots run commands on this computer": what main says it is now. */
export async function setTogetherCommands(on: boolean): Promise<boolean> {
  const page = bridge();
  if (!page?.setCommands) throw new Error("unavailable");
  const now = await page.setCommands(on);
  read();
  return now;
}

/** Keeps where the person moved bots in the one list. The list shows it at once; main's answer then stands. Whether main
 * kept every entry. */
export function arrangeOneList(entries: readonly ArrangedBot[]): Promise<boolean> {
  const page = bridge();
  if (!page?.arrange || !entries.length || !known?.on) return Promise.resolve(!entries.length);
  const keys = new Set(entries.map((entry) => entry.key));
  publish({ ...known, arranged: [...(known.arranged ?? []).filter((entry) => !keys.has(entry.key)), ...entries] });
  const same = (a: ArrangedBot, b: ArrangedBot) => a.key === b.key && a.section === b.section && a.after === b.after;
  return page.arrange([...entries]).then((kept) => { read(); return entries.every((entry) => kept.some((had) => same(had, entry))); }, () => { read(); return false; });
}

/** Opens one of the other place's bots there. */
export function openOtherPlaceBot(id: string): void {
  void bridge()?.open(id).catch(() => {});
}

export function resetPlacesTogetherForTest(): void {
  known = null;
  answered = false;
  watching = 0;
  unsubscribe = null;
  listeners.clear();
}

export type NewBotChoice = import("../../electron/places-together.mjs").NewBotChoice;

/** What differs about making a bot in the other place, as facts: it sleeps, no AI is ready there, or which AIs are
 * ready on one side only. Nothing when the two sides match or the other place could not be asked. */
export function newBotDifference(hereAis: readonly string[], choice: (Pick<NewBotChoice, "home" | "state"> & { ais: readonly string[] | null }) | null):
  { kind: "asleep" } | { kind: "noAi" } | { kind: "ais"; onlyThere: string[]; onlyHere: string[] } | null {
  if (!choice) return null;
  if (choice.home === "cloud" && (choice.state === "asleep" || choice.state === "waking")) return { kind: "asleep" };
  if (!choice.ais) return null;
  if (!choice.ais.length) return { kind: "noAi" };
  const fold = (name: string) => name.trim().toLowerCase();
  const here = new Set(hereAis.map(fold)), there = new Set(choice.ais.map(fold));
  const onlyThere = [...choice.ais].filter((name) => !here.has(fold(name))), onlyHere = hereAis.filter((name) => !there.has(fold(name)));
  return onlyThere.length || onlyHere.length ? { kind: "ais", onlyThere, onlyHere } : null;
}

/** An AI's name for a line the person reads: the name they gave it, or its engine's name when that name holds an
 * email address, which is never shown beside another place. */
export function aiLabel(name: string, kind: string, engineName: (kind: string) => string): string {
  return /\S@\S/.test(name) ? engineName(kind) : name;
}

/** The other place as the ＋ shows it, asked each time the menu opens. */
export function readNewBotChoice(): Promise<NewBotChoice | null> {
  return bridge()?.newBotChoice?.().catch(() => null) ?? Promise.resolve(null);
}

/** Makes the new bot in the other place: main opens it, and that place makes the bot. */
export function newBotInOtherPlace(): void {
  void bridge()?.newBot?.().catch(() => {});
}

/** The other place asked for a new bot here: `make` runs once this page is ready for it. */
export function useNewBotFromOtherPlace(ready: boolean, make: () => void): void {
  const [asked, setAsked] = useState(false);
  useEffect(() => bridge()?.onNewBot?.(() => setAsked(true)), []);
  useEffect(() => {
    if (!asked || !ready) return;
    setAsked(false);
    make();
  }, [asked, ready, make]);
}
