// This computer and My Cloud together (electron/places-together.mjs), as a page sees it: the other place's bots, listed
// beside its own. Every row carries its `home`, and ids are unique only within a place, so rows are keyed by home and id.
import { useEffect, useSyncExternalStore } from "react";
import type { BotHome, PlaceBotRow, PlacesTogetherState } from "../../electron/places-together.mjs";

export type { BotHome, PlaceBotRow, PlacesTogetherState };

/** A bot's key in a list that holds both places: ids are unique only within one. */
export const placedKey = (home: BotHome, id: string): string => `${home}:${id}`;

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
