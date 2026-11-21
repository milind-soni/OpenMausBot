import { describe, expect, it } from "vitest";

import { onlyNarrowSidePanels, sidebarFoldsForPanel, type OpenSidePanels } from "./sidebar-fold";
import { SIDEBAR_AND_NARROW_PANEL_FIT, SIDEBAR_AND_PANEL_FIT } from "./use-media-query";

const none: OpenSidePanels = { simple: true, remoteClient: false, bot: false, room: false, inbox: false, inboxWide: false, notifications: false, wide: false };
const minWidth = (query: string) => Number(/min-width: (\d+)px/.exec(query)![1]);
/** What the media queries say at a window `width` wide. */
const fitsAt = (width: number) => ({ wide: width >= minWidth(SIDEBAR_AND_PANEL_FIT), narrow: width >= minWidth(SIDEBAR_AND_NARROW_PANEL_FIT) });
const folds = (panels: Partial<OpenSidePanels>, width: number) => sidebarFoldsForPanel({ ...none, ...panels }, fitsAt(width));

describe("when the sidebar folds beside a side panel", () => {
  it("sets the narrow fit at the open sidebar, a 440 chat and a 320 panel", () => {
    expect(minWidth(SIDEBAR_AND_NARROW_PANEL_FIT)).toBe(280 + 440 + 320);
  });

  it("never folds with no side panel open, at any width", () => {
    for (const width of [800, 1039, 1040, 1279, 1280]) expect(folds({}, width)).toBe(false);
  });

  it.each([
    ["Simple's bot panel", { bot: true }],
    ["a room's panel", { room: true }],
    ["Simple's inbox", { inbox: true }],
    ["Notifications", { notifications: true }],
    ["the bot panel with Notifications", { bot: true, notifications: true }],
  ])("keeps the sidebar open beside %s from 1040 up, and folds it narrower", (_name, panels) => {
    expect(folds(panels, 1039)).toBe(true);
    expect(folds(panels, 1040)).toBe(false);
    expect(folds(panels, 1100)).toBe(false);
    expect(folds(panels, 1280)).toBe(false);
  });

  it.each([
    ["Advanced's bot panel", { simple: false, bot: true }],
    ["a remote client's bot panel", { remoteClient: true, bot: true }],
    ["Advanced's inbox", { simple: false, inbox: true }],
    ["a widened inbox", { inbox: true, inboxWide: true }],
    ["Computer, Inspector, Activity or Fork", { wide: true }],
    ["the bot panel with a wide one", { bot: true, wide: true }],
  ])("keeps folding beside %s until 1280, since it is wider than 320", (_name, panels) => {
    expect(onlyNarrowSidePanels({ ...none, ...panels })).toBe(false);
    expect(folds(panels, 1040)).toBe(true);
    expect(folds(panels, 1279)).toBe(true);
    expect(folds(panels, 1280)).toBe(false);
  });
});
