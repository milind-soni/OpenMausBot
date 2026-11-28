// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ADVANCED_MODE_KEY, setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { SIDEBAR_SELECTION_ACCENT_KEY } from "@/lib/sidebar-preferences";
import { BotEditorStore, initialState, type Bot } from "@/state/store";
import { SettingsLook } from "../../SettingsPrimitives";
import { Sidebar } from "../../Sidebar";
import { fullContext } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";
import { AppearancePage } from "./AppPages";

const bot = (id: string, name: string): Bot => ({
  id, name, threadId: `${id}-main`, title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
});
const store = {
  state: { ...initialState, connected: true, selectedId: "atlas", bots: [bot("atlas", "Atlas"), bot("scout", "Scout")] },
  dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
};

function Fixture() {
  const advanced = useAdvancedMode();
  const shell: SettingsShell = {
    ctx: fullContext({ advanced, desktop: false }),
    place: { name: "This computer", kind: "computer", color: null, named: false },
    page: "appearance", anchor: null, go: () => {},
  };
  return createElement(BotEditorStore, { value: store, children: [
    createElement(Sidebar, { key: "sidebar", open: true, onClose: () => {} }),
    createElement(SettingsShellContext.Provider, { key: "settings", value: shell },
      createElement(SettingsLook.Provider, { value: true }, createElement(AppearancePage))),
  ] });
}

it("offers Blue only in Advanced and remembers the sidebar style", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  localStorage.removeItem(SIDEBAR_SELECTION_ACCENT_KEY);
  setAdvancedMode(false);
  const host = document.body.appendChild(document.createElement("div"));
  let root = createRoot(host);
  const setting = () => host.querySelector<HTMLSelectElement>('select[aria-label="Selected conversation style"]');
  const accent = () => host.querySelector("aside[data-sidebar]")?.getAttribute("data-sidebar-selection");
  const pick = (value: string) => act(async () => {
    const select = setting()!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  try {
    await act(async () => root.render(createElement(Fixture)));
    expect(setting()).toBeNull();
    expect(accent()).toBe("charcoal");
    expect(host.querySelector('[data-sidebar-bot-row="atlas"].bg-raised')).not.toBeNull();

    await act(async () => setAdvancedMode(true));
    expect(setting()?.selectedOptions[0]?.textContent).toBe("Grey");
    expect(setting()?.closest('[data-settings-block="appearance"]')).not.toBeNull();
    await pick("blue");
    expect(accent()).toBe("blue");
    expect(setting()?.value).toBe("blue");
    expect(host.querySelector('[data-sidebar-bot-row="atlas"].sidebar-selected-row [data-sidebar-selection-avatar]')).not.toBeNull();
    expect(host.querySelector('[data-sidebar-bot-row="scout"].sidebar-selected-row')).toBeNull();
    expect(localStorage.getItem(SIDEBAR_SELECTION_ACCENT_KEY)).toBe("blue");

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_SELECTION_ACCENT_KEY }));
      root.unmount();
    });
    root = createRoot(host);
    await act(async () => root.render(createElement(Fixture)));
    expect(setting()?.value).toBe("blue");
    expect(accent()).toBe("blue");

    await act(async () => setAdvancedMode(false));
    expect(setting()).toBeNull();
    expect(accent()).toBe("blue");
    await act(async () => setAdvancedMode(true));
    await pick("charcoal");
    expect(accent()).toBe("charcoal");
    expect(localStorage.getItem(SIDEBAR_SELECTION_ACCENT_KEY)).toBe("charcoal");
  } finally {
    await act(async () => {
      localStorage.removeItem(SIDEBAR_SELECTION_ACCENT_KEY);
      localStorage.removeItem(ADVANCED_MODE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
