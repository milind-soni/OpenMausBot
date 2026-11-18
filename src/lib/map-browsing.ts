import { useEffect, useState } from "react";
import { api, openBot, type Action } from "@/state/store";
import { openComputerPanelOn } from "@/lib/computer-panel-focus";
import type { MapBrowsingPayload } from "../../shared/map-computer";

export const MAP_BROWSING_POLL_MS = 5_000;

/** The site a bot's chip names: only while it works, so a read from before its turn ended never lingers. */
export function browsingSiteOf(bot: { id: string; busy?: boolean }, sites: Readonly<Record<string, string>>): string | undefined {
  return bot.busy ? sites[bot.id] : undefined;
}

/** The chip's click: the bot's chat, with the Browser view of its panel open. */
export function openBotBrowser(dispatch: (action: Action) => void, bot: Parameters<typeof openBot>[1], threadsShown: boolean, opener: HTMLElement, keyboard: boolean): void {
  openBot(dispatch, bot, threadsShown);
  openComputerPanelOn(dispatch, bot.id, "browser", opener, keyboard);
}

/** Bot id to the site (host only) its built-in browser shows, read every five seconds while `enabled` and the page is in view. */
export function useMapBrowsing(enabled: boolean): Readonly<Record<string, string>> {
  const [sites, setSites] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const next: MapBrowsingPayload = await api("/api/computers/browsing", { signal: AbortSignal.timeout(10_000) });
        if (!stopped) setSites(Object.fromEntries(next.bots.map((entry) => [entry.botId, entry.site])));
      } catch {
        // The chip keeps its last read; the next poll asks again.
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
