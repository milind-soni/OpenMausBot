// This computer and My Cloud together (electron/places-together.mjs), as a page sees it: its own bots and the other
// place's in one list. Ids are unique only within a place, so everything here is keyed by home and id.
import { useEffect, useSyncExternalStore } from "react";
import type { BotHome, PlaceBotRow, PlacesTogetherState } from "../../electron/places-together.mjs";

export type { BotHome, PlaceBotRow, PlacesTogetherState };

/** One bot of the joined list. `home` is where it lives; `here`: that is the place this page shows. */
export interface PlacedBot {
  key: string;
  home: BotHome;
  here: boolean;
  id: string;
  name: string;
  unread: boolean;
}

export const placedKey = (home: BotHome, id: string): string => `${home}:${id}`;

type OwnBot = { id: string; name: string; hidden?: boolean; movedTo?: unknown; unread?: boolean; tasks?: ReadonlyArray<{ unread?: boolean; routineRunId?: string; archivedAt?: number }> | null };

const ownUnread = (bot: OwnBot): boolean => (bot.tasks?.length
  ? bot.tasks.some((task) => Boolean(task.unread) && !task.routineRunId && task.archivedAt === undefined) : Boolean(bot.unread));

/** This page's bots first, then the other place's, each with its home. With the switch off, only this page's. */
export function placedBots(own: readonly OwnBot[], state: PlacesTogetherState | null): PlacedBot[] {
  const here: BotHome = state?.here ?? "computer";
  const mine = own.filter((bot) => !bot.hidden && !bot.movedTo)
    .map((bot) => ({ key: placedKey(here, bot.id), home: here, here: true, id: bot.id, name: bot.name, unread: ownUnread(bot) }));
  const theirs = (state?.on ? state.other?.bots ?? [] : [])
    .map((bot) => ({ key: placedKey(bot.home, bot.id), home: bot.home, here: false, id: bot.id, name: bot.name, unread: bot.unread === true }));
  return [...mine, ...theirs];
}

/** How many bots show unread in each place. */
export function unreadByHome(bots: readonly PlacedBot[]): Record<BotHome, number> {
  const count: Record<BotHome, number> = { computer: 0, cloud: 0 };
  for (const bot of bots) if (bot.unread) count[bot.home] += 1;
  return count;
}

/** Opens a bot in the place it lives: this page's own way for its own bots, main's switch for the other place's. */
export function openPlaced(bot: Pick<PlacedBot, "here" | "id">, ways: { here(id: string): void; there(id: string): void }): void {
  if (bot.here) ways.here(bot.id); else ways.there(bot.id);
}

/** The other place's rows that match what the person typed in the sidebar's search. */
export function matchingRows(rows: readonly PlaceBotRow[], query: string): PlaceBotRow[] {
  const wanted = query.trim().toLowerCase();
  return wanted ? rows.filter((row) => row.name.toLowerCase().includes(wanted) || (row.title ?? "").toLowerCase().includes(wanted)) : [...rows];
}

const bridge = () => (typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.placesTogether);

let known: PlacesTogetherState | null = null;
let watching = 0, unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
const publish = (next: PlacesTogetherState | null) => { known = next; for (const listener of listeners) listener(); };
const read = () => { void bridge()?.state().then(publish, () => publish(null)); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What main says about the two places: null in a browser, on another place's page, and until main first answers. */
export function usePlacesTogether(): PlacesTogetherState | null {
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
  return useSyncExternalStore(subscribe, () => known, () => null);
}

/** Turns the switch, and says what main kept. */
export async function setPlacesTogether(on: boolean): Promise<void> {
  const page = bridge();
  if (page) publish(await page.set(on));
}

/** Opens one of the other place's bots there. */
export function openOtherPlaceBot(id: string): void {
  void bridge()?.open(id).catch(() => {});
}

export function resetPlacesTogetherForTest(): void {
  known = null;
  listeners.clear();
}
