// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { BotListItem, botRowProps } from "./Sidebar";

vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));
vi.mock("@/lib/thread-preferences", async (original) => ({ ...await original<typeof import("@/lib/thread-preferences")>(), useShowThreads: () => true }));
vi.mock("@/lib/sidebar-hover-threads", () => ({ useSidebarHoverThreads: () => true }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.body.innerHTML = ""; });
it("keeps selected chats in the popup and closes it when a chat is opened", async () => {
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
