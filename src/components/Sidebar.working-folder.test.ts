// @vitest-environment happy-dom
// Exercise the production entry point, including the menu closing while the
// Sidebar-owned dialog remains open. An unmounted picker export is not proof
// that a person can reach this workflow.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const access = vi.hoisted(() => ({ admin: true, advanced: true }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => access.admin }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => access.advanced,
}));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: false, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const bot: Bot = {
  id: "pepper", name: "Pepper", threadId: "current", title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" }, cwd: "/projects/default",
  tasks: [{ threadId: "current", title: "Current thread", createdAt: 1 }],
};
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots: [bot], selectedId: bot.id }, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(Sidebar, { open: true, onClose: () => {} }),
})));
const openMenu = () => flushSync(() => document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Pepper"]')!.click());
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label);

beforeEach(() => {
  access.admin = true;
  access.advanced = true;
  dispatch.mockReset();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("working folder through the rendered sidebar", () => {
  it("opens the dialog from the bot action menu and submits a new thread with its chosen path", () => {
    render();
    openMenu();
    expect(menuItem("New thread")).toBeDefined();
    flushSync(() => menuItem("New thread in a working folder…")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="New thread in a working folder…"]')!;
    expect(dialog).not.toBeNull();
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("/projects/default");
    expect(dispatch).not.toHaveBeenCalled();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/projects/next");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "newTask", botId: bot.id, cwd: "/projects/next" }));
    flushSync(() => dispatch.mock.calls[0]![0].onCreated());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-sidebar-bot-row="pepper"]'));
  });

  it("retains one-click normal creation and hides explicit folders from chat-only sessions", () => {
    access.admin = false;
    render();
    openMenu();
    expect(menuItem("New thread in a working folder…")).toBeUndefined();
    flushSync(() => menuItem("New thread")!.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "newTask", botId: bot.id });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps new-thread folder creation out of Simple mode", () => {
    access.advanced = false;
    render();
    openMenu();
    expect(menuItem("New thread")).toBeUndefined();
    expect(menuItem("New thread in a working folder…")).toBeUndefined();
  });
});
