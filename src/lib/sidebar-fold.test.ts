import { describe, expect, it } from "vitest";

import { anySidePanel, botPanelFloats, onlyNarrowSidePanels, panelsMovingSidebar, sidebarFoldsForPanel, type OpenSidePanels } from "./sidebar-fold";
import { SIDEBAR_AND_BOT_PANEL_FIT, SIDEBAR_AND_NARROW_PANEL_FIT, SIDEBAR_AND_PANEL_FIT } from "./use-media-query";

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
    ["a room's panel", { room: true }],
    ["Simple's inbox", { inbox: true }],
    ["Notifications", { notifications: true }],
    ["Simple's bot panel with Notifications", { bot: true, notifications: true }],
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

describe("Simple's bot panel and the sidebar", () => {
  it("never folds or narrows the sidebar, at any width: the chat makes the room, and below 920 the panel floats", () => {
    expect(minWidth(SIDEBAR_AND_BOT_PANEL_FIT)).toBe(280 + 320 + 320);
    for (const width of [760, 900, 919, 920, 1039, 1040, 1100, 1279, 1280, 1600]) {
      expect(folds({ bot: true }, width)).toBe(false);
      expect(anySidePanel(panelsMovingSidebar({ ...none, bot: true }))).toBe(false);
      expect(botPanelFloats({ ...none, bot: true }, width >= minWidth(SIDEBAR_AND_BOT_PANEL_FIT))).toBe(width < 920);
    }
  });

  it("leaves the rule for every other panel as it was, beside the bot panel too", () => {
    expect(folds({ bot: true, wide: true }, 1100)).toBe(true);
    expect(folds({ bot: true, room: true }, 1039)).toBe(true);
    expect(anySidePanel(panelsMovingSidebar({ ...none, bot: true, inbox: true }))).toBe(true);
  });

  it("keeps Advanced's and a remote client's wider bot panels on the old rule", () => {
    expect(folds({ simple: false, bot: true }, 1100)).toBe(true);
    expect(folds({ remoteClient: true, bot: true }, 1100)).toBe(true);
    expect(botPanelFloats({ ...none, simple: false, bot: true }, false)).toBe(false);
  });
});
