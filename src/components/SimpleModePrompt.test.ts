// @vitest-environment happy-dom
// The Simple mode popup: a switch that changes the app behind it as it is flipped, closed for good by Done, ×, Escape or
// a click outside.
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ADVANCED_MODE_KEY, readAdvancedMode, setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY, simpleModePromptSeen } from "@/lib/simple-mode-prompt";

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
const { SimpleModePrompt } = await import("./SimpleModePrompt");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, opener: HTMLButtonElement;
const onClose = vi.fn();
const dialog = () => host.querySelector<HTMLElement>("[data-simple-mode-prompt]");
const toggle = () => host.querySelector<HTMLButtonElement>("[data-simple-mode-switch]")!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label)!;
const show = async () => { await act(async () => { root.render(createElement(SimpleModePrompt, { onClose })); }); };
const key = async (name: string, shiftKey = false) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })); });
};
const events = () => analytics.track.mock.calls.filter(([event]) => event === "simple_mode_prompt").map(([, props]) => props);

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)), removeItem: (k: string) => void values.delete(k), clear: () => values.clear() };
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  analytics.track.mockReset();
  onClose.mockReset();
  opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  opener.remove();
  vi.unstubAllGlobals();
});

describe("the Simple mode popup", () => {
  it("invites someone on Advanced mode to try it, with the switch off", async () => {
    setAdvancedMode(true);
    await show();
    expect(dialog()?.getAttribute("role")).toBe("dialog");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("h2")?.textContent).toBe("Try the new Simple mode");
    expect(host.textContent).toContain("A calmer screen, with every feature still there.");
    expect(host.textContent).toContain("Switch any time in Settings → General.");
    expect(toggle().getAttribute("role")).toBe("switch");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement, "focus starts on the title, so no key flips the switch by accident").toBe(host.querySelector("h2"));
  });

  it("tells someone already on it so, with the switch on", async () => {
    setAdvancedMode(false);
    await show();
    expect(host.querySelector("h2")?.textContent).toBe("You're on Simple mode");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("changes the app the moment it is flipped, both ways, and keeps its words while it does", async () => {
    setAdvancedMode(true);
    const App = () => createElement("div", { "data-app": useAdvancedMode() ? "advanced" : "simple" });
    const app = () => host.querySelector<HTMLElement>("[data-app]")?.dataset.app;
    await act(async () => { root.render(createElement(Fragment, null, createElement(App), createElement(SimpleModePrompt, { onClose }))); });
    await act(async () => { toggle().click(); });
    expect(readAdvancedMode()).toBe(false);
    expect(localStorage.getItem(ADVANCED_MODE_KEY)).toBe("0");
    expect(app(), "the app behind it switches as it is flipped").toBe("simple");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("h2")?.textContent).toBe("Try the new Simple mode");
    await act(async () => { toggle().click(); });
    expect(readAdvancedMode()).toBe(true);
    expect(app()).toBe("advanced");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(events()).toEqual([{ action: "toggled", mode: "simple" }, { action: "toggled", mode: "advanced" }]);
    expect(onClose, "flipping never closes it").not.toHaveBeenCalled();
  });

  it("follows the mode when another tab changes it", async () => {
    setAdvancedMode(true);
    await show();
    localStorage.setItem(ADVANCED_MODE_KEY, "0");
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: ADVANCED_MODE_KEY, storageArea: localStorage })); });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it.each(["Done", "Close", "Escape", "outside"])("closes for good with %s, saying the mode it ends in", async (how) => {
    setAdvancedMode(false);
    await show();
    if (how === "Escape") await key("Escape");
    else if (how === "outside") await act(async () => { dialog()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    else await act(async () => { button(how).click(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(simpleModePromptSeen()).toBe(true);
    expect(localStorage.getItem(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    expect(events()).toEqual([{ action: "closed", mode: "simple" }]);
  });

  it("keeps the keyboard inside while it is open, and gives focus back when it closes", async () => {
    setAdvancedMode(true);
    await show();
    await key("Tab");
    expect(document.activeElement).toBe(toggle());
    await key("Tab");
    expect(document.activeElement).toBe(button("Done"));
    await key("Tab");
    expect(document.activeElement).toBe(button("Close"));
    await key("Tab");
    expect(document.activeElement, "round to the first again").toBe(toggle());
    await key("Tab", true);
    expect(document.activeElement).toBe(button("Close"));
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(document.activeElement).toBe(opener);
  });

  it("lets motion go for anyone who asks for less", async () => {
    await show();
    expect(dialog()!.className).toContain("motion-reduce:animate-none");
    expect(toggle().className).toContain("motion-reduce:transition-none");
  });
});
