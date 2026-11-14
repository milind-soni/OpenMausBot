// @vitest-environment happy-dom
// The settings dialog closes on Escape, unless something inside it already handled that Escape (a popover menu
// closing, a field clearing).
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, settingsOpen: true }, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
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

const { BotSettingsDialog } = await import("./BotSettingsDialog");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};

let host: HTMLDivElement;
let root: Root;
const dialog = () => host.querySelector<HTMLElement>('aside[role="dialog"]')!;
const escape = (target: Element) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
const closes = () => fixture.dispatch.mock.calls.filter(([action]) => action.type === "toggleSettings" && action.open === false);

beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(BotSettingsDialog, { bot })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("Escape in the bot settings dialog", () => {
  it("closes the dialog", () => {
    escape(dialog());
    expect(closes()).toHaveLength(1);
  });

  it("leaves the dialog open when something inside already handled the Escape", () => {
    const section = dialog().querySelector("[data-bot-settings-section] button")!;
    section.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    escape(section);
    expect(closes()).toHaveLength(0);
    escape(section);
    expect(closes()).toHaveLength(1);
  });
});
