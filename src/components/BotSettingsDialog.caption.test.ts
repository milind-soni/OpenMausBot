import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

// The full fold-out panel this checks is Advanced mode's.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({}) }));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: store.initialState, dispatch: vi.fn(), flushBotPatches: vi.fn() }) };
});
import { BotSettingsDialog } from "./BotSettingsDialog";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";

const bot = { id: "bot-1", name: "Maily" } as never as Bot;
// The provider reads window.ogb.platform on render, so each case sees its stub.
const headerTag = () => {
  const html = renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null, createElement(BotSettingsDialog, { bot })));
  return html.match(/<div[^>]*>(?=<span id="bot-settings-title")/)?.[0] ?? "";
};
const header = () => headerTag().match(/class="([^"]*)"/)?.[1] ?? "";

afterEach(() => vi.unstubAllGlobals());

describe("bot settings caption inset", () => {
  // The window frame's top bar holds the caption buttons and the traffic lights, above the app's card.
  it.each(["win32", "darwin"] as const)("keeps the header flush on %s: the frame's top bar holds the window's buttons", (platform) => {
    vi.stubGlobal("window", { ogb: { platform } });
    const classes = header();
    expect(classes).toContain("py-3");
    expect(classes).not.toContain("pt-[28px]");
  });

  it.each([["darwin", true], ["win32", true], ["linux", false]] as const)(
    "makes the header a window drag region on %s: %s",
    (platform, drags) => {
      vi.stubGlobal("window", { ogb: { platform } });
      const tag = headerTag();
      expect(tag.includes("data-window-drag")).toBe(drags);
      expect(tag.includes("-webkit-app-region:drag")).toBe(drags);
    },
  );
});
