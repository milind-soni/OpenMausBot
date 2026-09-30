import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

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
const header = () => {
  const html = renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null, createElement(BotSettingsDialog, { bot })));
  return html.match(/<div class="([^"]*)"><span id="bot-settings-title"/)?.[1] ?? "";
};

afterEach(() => vi.unstubAllGlobals());

describe("bot settings caption inset", () => {
  it("drops the close button below the Windows caption buttons", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    expect(header()).toContain("pt-[28px]");
  });

  it("keeps the header flush elsewhere", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const classes = header();
    expect(classes).toContain("py-3");
    expect(classes).not.toContain("pt-[28px]");
  });
});
