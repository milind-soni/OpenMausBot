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

/** Whether the sidebar folds to its column of avatars: only while a side panel is open and the window is too narrow
 * for the sidebar, a chat of at least 440 and that panel. */
export function sidebarFoldsForPanel(panels: OpenSidePanels, fits: { wide: boolean; narrow: boolean }): boolean {
  if (!anySidePanel(panels) || fits.wide) return false;
  return !(fits.narrow && onlyNarrowSidePanels(panels));
}
