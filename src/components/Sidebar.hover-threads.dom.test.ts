// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { BotListItem, botRowProps } from "./Sidebar";
import { RecentChatsPopup, useRecentChatsPopup } from "./SidebarRecentChats";
import { setSidebarHoverThreads } from "@/lib/sidebar-hover-threads";

vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));
vi.mock("@/lib/thread-preferences", async (original) => ({ ...await original<typeof import("@/lib/thread-preferences")>(), useShowThreads: () => true }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });
it("keeps selected chats in the popup and closes it when a chat is opened", async () => {
  setSidebarHoverThreads(true);
  const bot: Bot = { id: "atlas", threadId: "one", name: "Atlas", title: "", description: "", notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "claude", model: "test" }, messages: [], tasks: [{ threadId: "one", title: "First", createdAt: 1 }, { threadId: "two", title: "Second", createdAt: 2 }] };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(BotListItem, botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }))); });
  const row = document.querySelector<HTMLElement>('[data-sidebar-bot-row="atlas"]')!;
  await act(async () => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  const popup = () => document.querySelector<HTMLElement>('[data-recent-chats-popup="atlas"]');
  const button = (text: string) => [...popup()!.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;
  expect(popup()).not.toBeNull();
  await act(async () => { button("Select threads").click(); });
  const first = popup()!.querySelector<HTMLElement>('[role="checkbox"]')!;
  await act(async () => { first.click(); });
  expect(popup()).not.toBeNull();
  expect(first.getAttribute("aria-checked")).toBe("true");
  await act(async () => { button("Done").click(); });
  await act(async () => { popup()!.querySelector<HTMLButtonElement>('[data-sidebar-thread-row]')!.click(); });
  expect(popup()).toBeNull();
  await act(async () => { root.unmount(); });
});

it("moves keyboard focus into recent chats and closes when focus leaves", async () => {
  setSidebarHoverThreads(true);
  const bot: Bot = { id: "atlas", threadId: "one", name: "Atlas", title: "", description: "", notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "claude", model: "test" }, messages: [], tasks: [{ threadId: "one", title: "First", createdAt: 1 }, { threadId: "two", title: "Second", createdAt: 2 }] };
  const host = document.body.appendChild(document.createElement("div"));
  const outside = document.body.appendChild(document.createElement("button"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(BotListItem, botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }))); });
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Expand Atlas threads"]')!;
  await act(async () => { trigger.focus(); trigger.click(); });
  const popup = document.querySelector<HTMLElement>('[data-recent-chats-popup="atlas"]')!;
  expect(popup.contains(document.activeElement)).toBe(true);
  await act(async () => { outside.focus(); });
  expect(document.querySelector('[data-recent-chats-popup="atlas"]')).toBeNull();
  await act(async () => { root.unmount(); });
});

it("restores the inline arrow for a single chat when hover is disabled", async () => {
  setSidebarHoverThreads(true);
  const bot: Bot = { id: "solo", threadId: "one", name: "Solo", title: "", description: "", notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "claude", model: "test" }, messages: [], tasks: [{ threadId: "one", title: "First", createdAt: 1 }] };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(BotListItem, botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }))); });
  await act(async () => { setSidebarHoverThreads(false); });
  const arrow = document.querySelector<HTMLButtonElement>('[aria-label="Expand Solo threads"]')!;
  expect(arrow).not.toBeNull();
  expect(arrow.className).not.toContain("opacity-0");
  await act(async () => { arrow.click(); });
  expect(document.querySelector('[data-sidebar-thread-row="one"]')).not.toBeNull();
  await act(async () => { root.unmount(); });
});

it("focuses an empty popup and dismisses it after its menu closes", async () => {
  vi.useFakeTimers();
  function Fixture() {
    const { popover, rowRef, popupRef, cancelClose, closeLater, openPopover } = useRecentChatsPopup();
    return createElement("div", { ref: rowRef },
      createElement("button", { onClick: () => openPopover(true) }, "Open"),
      popover && createElement(RecentChatsPopup, { popupRef, botId: "test", position: popover, onEnter: cancelClose, onLeave: closeLater, children: null }));
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Fixture)); });
  await act(async () => { host.querySelector("button")!.click(); });
  const popup = document.querySelector<HTMLElement>('[data-recent-chats-popup="test"]')!;
  expect(document.activeElement).toBe(popup);
  const overlay = document.body.appendChild(document.createElement("div"));
  overlay.setAttribute("data-thread-overlay", "");
  await act(async () => { (document.activeElement as HTMLElement).blur(); popup.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); await vi.advanceTimersByTimeAsync(250); });
  expect(document.body.contains(popup)).toBe(true);
  await act(async () => { overlay.remove(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(250); });
  expect(document.body.contains(popup)).toBe(false);
  await act(async () => { root.unmount(); });
  vi.useRealTimers();
});
