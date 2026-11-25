/** The side panels open beside the chat, and which of them are 320px wide or less. */
export interface OpenSidePanels {
  /** Simple mode: the bot panel and the inbox are 320 wide; Advanced draws them wider. */
  simple: boolean;
  /** A remote client's bot panel is 400 wide. */
  remoteClient: boolean;
  /** The bot panel (Simple 320, Advanced up to 420). */
  bot: boolean;
  /** A room's panel, 320 in both modes. */
  room: boolean;
  /** The inbox: 320 in Simple, 380 in Advanced, wider still when widened. */
  inbox: boolean;
  inboxWide: boolean;
  /** Notifications, 300. */
  notifications: boolean;
  /** Computer (360 and up), Inspector (up to 460), Activity (400), Fork (360). */
  wide: boolean;
}

export function anySidePanel(panels: OpenSidePanels): boolean {
  return panels.bot || panels.room || panels.inbox || panels.notifications || panels.wide;
}

/** Whether every open side panel is 320px wide or less, so the open sidebar (280) and a chat of at least 440 fit beside
 * it from SIDEBAR_AND_NARROW_PANEL_FIT up. */
export function onlyNarrowSidePanels(panels: OpenSidePanels): boolean {
  if (panels.wide) return false;
  if (panels.bot && (!panels.simple || panels.remoteClient)) return false;
  if (panels.inbox && (!panels.simple || panels.inboxWide)) return false;
  return true;
}

/** Simple's own bot panel (not a remote client's): the one panel that never moves the sidebar. */
function simpleBotPanel(panels: OpenSidePanels): boolean {
  return panels.bot && panels.simple && !panels.remoteClient;
}

/** The open panels that make room for themselves out of the sidebar. Simple's bot panel is not one: opening or closing
 * it leaves the sidebar's width, and its pinned bots, exactly as they were. */
export function panelsMovingSidebar(panels: OpenSidePanels): OpenSidePanels {
  return simpleBotPanel(panels) ? { ...panels, bot: false } : panels;
}

/** Whether Simple's bot panel floats over the chat's edge instead of standing beside it: in a window too narrow for
 * the open sidebar, a chat of 320 and the panel (`fits`, SIDEBAR_AND_BOT_PANEL_FIT). */
export function botPanelFloats(panels: OpenSidePanels, fits: boolean): boolean {
  return simpleBotPanel(panels) && !fits;
}

/** Whether the sidebar folds to its column of avatars: only while a side panel that moves it is open and the window is
 * too narrow for the sidebar, a chat of at least 440 and that panel. */
export function sidebarFoldsForPanel(open: OpenSidePanels, fits: { wide: boolean; narrow: boolean }): boolean {
  const panels = panelsMovingSidebar(open);
  if (!anySidePanel(panels) || fits.wide) return false;
  return !(fits.narrow && onlyNarrowSidePanels(panels));
}
