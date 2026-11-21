import { useEffect, useRef, useState } from "react";
import { api, openBot, type Action } from "@/state/store";
import { openComputerPanelOn } from "@/lib/computer-panel-focus";
import type { MapBrowsingPayload } from "../../shared/map-computer";

export const MAP_BROWSING_POLL_MS = 5_000;

const ownEntry = <T>(record: Readonly<Record<string, T>>, id: string): T | undefined => (Object.hasOwn(record, id) ? record[id] : undefined);

export function browsingSiteOf(bot: { id: string; busy?: boolean }, sites: Readonly<Record<string, string>>): string | undefined {
  return bot.busy ? ownEntry(sites, bot.id) : undefined;
}

/** The reads of bots still working: one that stopped never starts its next turn with the last turn's site. */
export function keepWorking(sites: Readonly<Record<string, string>>, busyBotIds: string): Readonly<Record<string, string>> {
  const busy = new Set(busyBotIds.split(" "));
  return Object.keys(sites).every((id) => busy.has(id)) ? sites : Object.fromEntries(Object.entries(sites).filter(([id]) => busy.has(id)));
}

/** Each working bot's id, with the number of the turn the map saw it start. */
export type WorkingTurns = Readonly<Record<string, number>>;

/** The working bots after `busyBotIds` changed: a bot keeps its number while it works and gets a new one each time it starts. */
export function nextWorkingTurns(current: WorkingTurns, busyBotIds: string, nextTurn: () => number): WorkingTurns {
  return Object.fromEntries(busyBotIds.split(" ").filter(Boolean).map((id) => [id, ownEntry(current, id) ?? nextTurn()]));
}

/** One read of the bots' sites, in the background so it never wakes a Cloud home that went to sleep. A site counts only
 * for a bot still in the turn it was in when the read went out. */
export async function readMapBrowsing(working: () => WorkingTurns): Promise<Readonly<Record<string, string>>> {
  const sent = working();
  const next: MapBrowsingPayload = await api("/api/computers/browsing", { background: true, timeoutMs: 10_000 });
  const now = working();
  return Object.fromEntries(next.bots.filter(({ botId }) => ownEntry(sent, botId) !== undefined && ownEntry(now, botId) === ownEntry(sent, botId)).map((entry) => [entry.botId, entry.site]));
}

/** A click on the card's "Browsing <site>" status line: the bot's chat, with the Browser view of its panel open. */
export function openBotBrowser(dispatch: (action: Action) => void, bot: Parameters<typeof openBot>[1], threadsShown: boolean, opener: HTMLElement, keyboard: boolean): void {
  openBot(dispatch, bot, threadsShown);
  openComputerPanelOn(dispatch, bot.id, "browser", opener, keyboard);
}

/** Bot id to the site (host only) its built-in browser shows, read every five seconds while `enabled` and the page is in view.
 * `busyBotIds` is the working bots' ids, space-separated. */
export function useMapBrowsing(enabled: boolean, busyBotIds: string): Readonly<Record<string, string>> {
  const [sites, setSites] = useState<Readonly<Record<string, string>>>({});
  const turn = useRef(0);
  const working = useRef<WorkingTurns>({});
  useEffect(() => {
    working.current = nextWorkingTurns(working.current, busyBotIds, () => ++turn.current);
    setSites((current) => keepWorking(current, busyBotIds));
  }, [busyBotIds]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const next = await readMapBrowsing(() => working.current);
        if (!stopped) setSites(next);
      } catch {
        // A read that fails confirms nothing: no site on the card until one succeeds.
        if (!stopped) setSites({});
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, MAP_BROWSING_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      // A bot that starts working again shows nothing until a fresh read, never the site of its last turn.
      setSites({});
    };
  }, [enabled]);
  return sites;
}
