// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

// Advanced mode's fold-out settings list Library too, with what the bot made, as Simple mode's panel does.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({}) }));
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), onOpen: undefined as undefined | ((page: string) => void) }));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  const state = { ...store.initialState, botSettingsSection: "library", botSettingsExpandAccordion: true };
  return { ...store, useStore: () => ({ state, dispatch: fixture.dispatch, flushBotPatches: vi.fn() }) };
});
vi.mock("./bot-panel/LibraryTab", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bot-panel/LibraryTab")>();
  return {
    ...original,
    LibraryTab: (props: Parameters<typeof original.LibraryTab>[0]) => {
      fixture.onOpen = props.onOpen as (page: string) => void;
      return original.LibraryTab(props);
    },
  };
});
import { BotSettingsDialog } from "./BotSettingsDialog";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";

const bot = { id: "bot-1", name: "Maily", threadId: "bot-1-main", messages: [], tasks: [] } as never as Bot;
const html = () => renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null, createElement(BotSettingsDialog, { bot })));

describe("Advanced bot settings", () => {
  it("has a Library section that shows the bot's library when open", () => {
    const markup = html();
    expect(markup).toContain('data-bot-settings-section="library"');
    expect(markup).toContain('data-panel-tabpanel="library"');
  });

  it("opens the matching settings section from each Library row", () => {
    html();
    for (const [page, section] of [["memory", "memory"], ["folder", "access"], ["apps", "overview"]]) {
      fixture.dispatch.mockClear();
      fixture.onOpen!(page);
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section });
    }
  });
});
