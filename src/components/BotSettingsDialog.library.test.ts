// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

// Advanced mode's fold-out settings list Library too, with what the bot made, as Simple mode's panel does.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({}) }));
const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  const state = { ...store.initialState, botSettingsSection: "library", botSettingsExpandAccordion: true };
  return { ...store, useStore: () => ({ state, dispatch: fixture.dispatch, flushBotPatches: vi.fn() }) };
});
import { BotSettingsDialog } from "./BotSettingsDialog";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bot = { id: "bot-1", name: "Maily", threadId: "bot-1-main", messages: [], tasks: [] } as never as Bot;
const dialog = () => createElement(DesktopCapabilitiesProvider, null, createElement(BotSettingsDialog, { bot }));

describe("Advanced bot settings", () => {
  it("has a Library section that shows the bot's library when open", () => {
    const markup = renderToStaticMarkup(dialog());
    expect(markup).toContain('data-bot-settings-section="library"');
    expect(markup).toContain('data-panel-tabpanel="library"');
  });

  it("keeps memory, skills and the folder in their own sections, not as rows in Library, and their headers open them", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(dialog()));
    expect(host.querySelector('[data-bot-settings-section="library"] [data-panel-page]')).toBeNull();
    for (const section of ["memory", "skills", "access"]) {
      fixture.dispatch.mockClear();
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-bot-settings-section="${section}"] > button`)!.click());
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section });
    }
    await act(async () => root.unmount());
    host.remove();
  });
});
