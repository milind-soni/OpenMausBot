import { useCallback, useContext, useEffect, useRef, type MouseEvent } from "react";
import { PAGE_ID } from "../../shared/published-page";
import { StoreContext, type Bot } from "@/state/store";
import { openExternalLink } from "./app-links";
import { browserAvailable, builtInBrowserEnabled, type FeatureFlagConfig } from "./feature-flags";

export const PAGES_DOMAIN = "mausbot.page";

/** A link to a page a bot published: https://<page id>.mausbot.page/… Never an app, chat or prompt link. */
export function isPublishedPageUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase(), suffix = `.${PAGES_DOMAIN}`;
  return host.endsWith(suffix) && PAGE_ID.test(host.slice(0, -suffix.length));
}

export interface PageOpenFacts {
  selectedId: string | null;
  bots: ReadonlyArray<Pick<Bot, "id" | "browser">>;
  groups: ReadonlyArray<{ id: string }>;
  config: FeatureFlagConfig | null | undefined;
  /** The desktop app's bridge, which only the desktop app's window has. */
  desktop: { remoteClient?: { active?: boolean } } | undefined;
}

/**
 * The bot whose browser, in the panel on the right, shows a published page; null opens it outside the chat instead (the
 * system browser in the desktop app, a new tab on the web). Only the desktop app's window, only a page link, and only a
 * bot chat whose browser is on and installed; never a room, and never the remote client, which has no such panel.
 */
export function pagePanelBot(url: string, facts: PageOpenFacts): string | null {
  if (!facts.desktop || facts.desktop.remoteClient?.active || !isPublishedPageUrl(url)) return null;
  if (facts.groups.some((group) => group.id === facts.selectedId)) return null;
  const bot = facts.bots.find((candidate) => candidate.id === facts.selectedId);
  const engine = facts.config?.browserEngine;
  if (!bot || bot.browser === false || !builtInBrowserEnabled(facts.config) || !browserAvailable(facts.config)) return null;
  return engine?.installing || engine?.installError ? null : bot.id;
}

export interface PanelPage { botId: string; url: string; nonce: number; at: number }
/** A request older than this is dropped, so a panel opened much later never opens a page by surprise. */
const PANEL_PAGE_FRESH_MS = 10_000;
let pending: PanelPage | null = null, nonce = 0;
const takers = new Set<() => void>();

export function requestPanelPage(botId: string, url: string, now = Date.now()): void {
  pending = { botId, url, nonce: ++nonce, at: now };
  for (const take of takers) take();
}

/** Hands `open` each page asked for this bot's panel, once: the panel shows its browser and opens the page in a new tab. */
export function usePanelPage(botId: string, open: (page: PanelPage) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const take = () => {
      const page = pending;
      if (!page || page.botId !== botId) return;
      pending = null;
      if (Date.now() - page.at <= PANEL_PAGE_FRESH_MS) latest.current(page);
    };
    take();
    takers.add(take);
    return () => { takers.delete(take); };
  }, [botId]);
}

/** Opens a link the way a published page's Open does: a page in the bot's browser panel when the desktop app has one,
 * anything else outside the chat. It never sends a message, starts a turn or opens a chat. */
export function usePageOpener(): (url: string) => void {
  // Outside the app's store (a message drawn on its own) there is no panel: the page opens outside the chat.
  const store = useContext(StoreContext);
  const latest = useRef(store);
  latest.current = store;
  return useCallback((url: string) => {
    const app = latest.current, state = app?.state;
    const botId = app && state ? pagePanelBot(url, { selectedId: state.selectedId, bots: state.bots ?? [], groups: state.groups ?? [], config: state.config, desktop: window.ogb }) : null;
    if (!app || !botId) { void openExternalLink(url).catch(() => {}); return; }
    requestPanelPage(botId, url);
    app.dispatch({ type: "toggleComputer", open: true });
  }, []);
}

/** A page link's click opens it like the card's Open; a click its hover card already took stays taken. */
export function withPageOpen<T extends { onClick?: (event: MouseEvent<HTMLElement>) => void }>(href: string | undefined, open: (url: string) => void, anchor: T): T {
  if (!isPublishedPageUrl(href)) return anchor;
  return { ...anchor, onClick: (event: MouseEvent<HTMLElement>) => {
    anchor.onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    open(href);
  } };
}
