// The browser dock: the bot's live page shown in the chat column, pinned
// between the transcript and the composer. Pure decisions live here so the
// component only wires them to the store and the Electron bridge.
//
// Why a dock and not a card in the message stream: the page is a native
// Electron view that paints above React and takes only a window rectangle.
// The transcript's scroll container cannot clip it, so a card that scrolled
// past the header would draw over it. Pinned above the composer, the
// transcript scrolls behind the page and the rectangle never needs clipping.

/** "open" shows the live page; "collapsed" leaves a one-line bar the person
 * can reopen from. Absent means the bot has not opened a page this session
 * (or closed its browser), so nothing is shown. */
export type BrowserDockState = "open" | "collapsed";

/** Pages that carry no content worth surfacing. A fresh view sits on
 * about:blank until the bot's first navigation. */
export function browserDockHasPage(url: string | null | undefined): boolean {
  const value = String(url ?? "").trim();
  return value !== "" && value !== "about:blank";
}

/** What the dock should show after a surface or control change.
 *
 * - The view closing removes the dock.
 * - A plea for help always opens it: the person must see what the bot is
 *   stuck on and the button that answers it.
 * - The first real page opens it. After that, a person who collapsed it
 *   keeps it collapsed until the next plea or until they reopen it.
 */
export function nextBrowserDockState(input: {
  current: BrowserDockState | undefined;
  surfaceOpen: boolean;
  url: string | null | undefined;
  helpReason: string | null | undefined;
}): BrowserDockState | undefined {
  if (!input.surfaceOpen) return undefined;
  if (input.helpReason) return "open";
  if (input.current) return input.current;
  return browserDockHasPage(input.url) ? "open" : undefined;
}

/** Whether the chat column may host the dock at all: the workspace flag,
 * the bot's own browser switch, a desktop bridge, and a composer of its
 * own (Spaces renders one floating composer for many chats, and a dock per
 * card would fight over the same native view). */
export function browserDockAvailable(input: {
  featureEnabled: boolean;
  botBrowser: boolean | undefined;
  bridge: boolean;
  composer: boolean;
  remoteClient: boolean;
}): boolean {
  return (
    input.featureEnabled &&
    input.botBrowser !== false &&
    input.bridge &&
    input.composer &&
    !input.remoteClient
  );
}

/** Short label for the collapsed bar and the panel placeholder: the page
 * title when there is one, else the host, else nothing. */
export function browserDockLabel(surface: { url?: string; title?: string } | null | undefined): string {
  const title = String(surface?.title ?? "").trim();
  if (title) return title;
  const url = String(surface?.url ?? "").trim();
  if (!browserDockHasPage(url)) return "";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Only one React host may position the native view at a time. While the
 * dock is open it owns the rectangle; the Computer panel's Browser tab shows
 * a note instead of a second, competing host. */
export function computerPanelHostsBrowser(dock: BrowserDockState | undefined): boolean {
  return dock !== "open";
}
