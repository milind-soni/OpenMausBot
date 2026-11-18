import { useEffect, useRef, useState } from "react";
import { api, openBot, type Action } from "@/state/store";
import { openComputerPanelOn } from "@/lib/computer-panel-focus";
import type { MapBrowsingPayload } from "../../shared/map-computer";

export const MAP_BROWSING_POLL_MS = 5_000;

/** The site a bot's chip names: only while it works, so a read from before its turn ended never lingers. */
export function browsingSiteOf(bot: { id: string; busy?: boolean }, sites: Readonly<Record<string, string>>): string | undefined {
  return bot.busy ? sites[bot.id] : undefined;
}

/** The reads of bots still working: one that stopped never starts its next turn with the last turn's site. */
export function keepWorking(sites: Readonly<Record<string, string>>, busyBotIds: string): Readonly<Record<string, string>> {
  const busy = new Set(busyBotIds.split(" "));
  return Object.keys(sites).every((id) => busy.has(id)) ? sites : Object.fromEntries(Object.entries(sites).filter(([id]) => busy.has(id)));
}

/** One read of the bots' sites, in the background so it never wakes a Cloud home that went to sleep. A bot that stopped
 * working while the read was out is left out: `busyBotIds` is asked once the answer is back. */
export async function readMapBrowsing(busyBotIds: () => string): Promise<Readonly<Record<string, string>>> {
  const next: MapBrowsingPayload = await api("/api/computers/browsing", { background: true, timeoutMs: 10_000 });
  return keepWorking(Object.fromEntries(next.bots.map((entry) => [entry.botId, entry.site])), busyBotIds());
}

/** The chip's click: the bot's chat, with the Browser view of its panel open. */
export function openBotBrowser(dispatch: (action: Action) => void, bot: Parameters<typeof openBot>[1], threadsShown: boolean, opener: HTMLElement, keyboard: boolean): void {
  openBot(dispatch, bot, threadsShown);
  openComputerPanelOn(dispatch, bot.id, "browser", opener, keyboard);
}

/** Bot id to the site (host only) its built-in browser shows, read every five seconds while `enabled` and the page is in view.
 * `busyBotIds` is the working bots' ids, space-separated. */
export function useMapBrowsing(enabled: boolean, busyBotIds: string): Readonly<Record<string, string>> {
  const [sites, setSites] = useState<Readonly<Record<string, string>>>({});
  const busy = useRef(busyBotIds);
  useEffect(() => {
    busy.current = busyBotIds;
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
        const next = await readMapBrowsing(() => busy.current);
        if (!stopped) setSites(next);
      } catch {
        // A read that fails confirms nothing: no chip until one succeeds.
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
