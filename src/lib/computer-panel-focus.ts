/** The chat header's computer button and the side panel it opens agree on one
 * thing: who opened the panel and where focus belongs while it is up. A panel
 * is a lazy screen, so the intent is recorded on open and taken by the panel's
 * first render, never by a timer on the opener's side. */
import { useEffect, useRef, type RefObject } from "react";

export type ComputerPanelOpen = {
  botId: string;
  opener: HTMLElement | null;
  /** The activation came from the keyboard, so the panel takes focus. */
  tabs: boolean;
};

let pendingTabFocus: string | null = null;
let opener: { botId: string; element: HTMLElement | null } | null = null;

export function rememberComputerPanelOpen(open: ComputerPanelOpen): void {
  opener = { botId: open.botId, element: open.opener };
  pendingTabFocus = open.tabs ? open.botId : null;
}

/** One shot per open: a panel that remounts for the same bot (a bot switch, or
 * React's double-invoked effects in development) must not take focus again. */
export function takeComputerPanelTabFocus(botId: string): boolean {
  if (pendingTabFocus !== botId) return false;
  pendingTabFocus = null;
  return true;
}

/** The panel's own tab row. A browser tab strip nested in a panel is not it. */
function entryTab(root: HTMLElement | null): HTMLElement | null {
  for (const list of root?.querySelectorAll<HTMLElement>('[role="tablist"]') ?? []) {
    if (list.closest('[role="tabpanel"]')) continue;
    return list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  }
  return null;
}

/** The first thing a keyboard user should reach: the active tab, or the close
 * button when the panel has no tab row. */
export function focusComputerPanelEntry(root: HTMLElement | null): void {
  (entryTab(root) ?? root?.querySelector<HTMLElement>("[data-computer-panel-close]"))?.focus();
}

/** A panel's side of the hand-off: the one-shot intent is taken on the first
 * render, the entry point is focused a frame later, and the ring then follows
 * `selection` (the panel's own tab) until the keyboard user leaves the tab row. */
export function useComputerPanelEntry(botId: string, selection?: unknown): RefObject<HTMLElement | null> {
  const panelRef = useRef<HTMLElement>(null);
  // One shot per open, and it must survive React's double-invoked development effects.
  const entryFocus = useRef<boolean | undefined>(undefined);
  const following = useRef(false);
  if (entryFocus.current === undefined) entryFocus.current = takeComputerPanelTabFocus(botId);
  useEffect(() => {
    if (!entryFocus.current) return;
    const frame = requestAnimationFrame(() => {
      focusComputerPanelEntry(panelRef.current);
      following.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  // Auto resolves its surface long after the panel is up, and a data result or a
  // sign-in moves the tab too.
  useEffect(() => {
    if (!following.current) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.getAttribute("role") !== "tab" || !panelRef.current?.contains(active)) {
      following.current = false;
      return;
    }
    focusComputerPanelEntry(panelRef.current);
  }, [selection]);
  return panelRef;
}

function onScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
}

/** The sidebar row survives the panel, but at narrow widths the sidebar is an
 * off-canvas drawer: focusing the row there would focus something unseen. */
function sidebarBotRow(botId: string): HTMLElement | null {
  for (const row of document.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")) {
    if (row.dataset.sidebarBotRow === botId && onScreen(row)) return row;
  }
  return null;
}

/** Called by a panel's own close controls, before the close is dispatched:
 * unmounting drops focus to the body, and the panel is gone by then. */
export function releaseComputerPanelFocus(root: HTMLElement | null, botId: string): void {
  if (!root || !root.contains(document.activeElement)) return;
  const target = opener?.botId === botId && opener.element?.isConnected ? opener.element
    : document.querySelector<HTMLElement>('[data-tour="computer"]')
      ?? sidebarBotRow(botId)
      ?? document.querySelector<HTMLElement>('[data-tour="composer"] textarea');
  target?.focus();
}
