// @vitest-environment happy-dom
// Switching bots keeps the settings dialog on screen (its slide-in must not replay), but an open section must not keep
// what the previous bot typed: an unsaved draft of bot A would otherwise sit in the field under bot B and be saved there.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, settingsOpen: true, botSettingsExpandAccordion: true, botSettingsSection: "soul" },
      dispatch: vi.fn(),
      flushBotPatches: () => Promise.resolve(null),
    }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, readAdvancedMode: () => true, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({ patch: vi.fn() }) }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/MemorySection", () => ({ MemorySection: () => null }));
vi.mock("./bot-settings/useBotOverview", () => ({
  useBotOverview: () => ({ overview: null, overviewError: false, prompt: null, promptError: false }),
  useBotHistory: () => ({ rows: null, error: false, revision: null, rollingBack: false }),
  HistoryRollbackDialog: () => null,
}));
// A section with a field that holds its own draft, like the real Soul editor: the draft lives in the section, not the bot.
vi.mock("./bot-settings/SoulSection", async () => {
  const { createElement: h } = await import("react");
  return { SoulSection: ({ bot }: { bot: { soul: string } }) => h("input", { "data-testid": "soul", defaultValue: bot.soul }) };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");

const scout: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "Be brief.",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const other: Bot = { ...scout, id: "other", name: "Other", soul: "Speak slowly." };

let host: HTMLDivElement;
let root: Root;
const dialog = () => host.querySelector<HTMLElement>('aside[role="dialog"]')!;
const soulField = () => host.querySelector<HTMLInputElement>('[data-testid="soul"]')!;
const show = (bot: Bot) => flushSync(() => root.render(createElement(BotSettingsDialog, { bot })));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the bot settings dialog after a switch", () => {
  it("keeps the same dialog element, and a section does not keep the previous bot's unsaved text", () => {
    show(scout);
    const before = dialog();
    expect(soulField().value).toBe("Be brief.");
    soulField().value = "Draft typed for Scout, not saved";
    show(other);
    expect(dialog()).toBe(before);
    expect(soulField().value).toBe("Speak slowly.");
  });
});
