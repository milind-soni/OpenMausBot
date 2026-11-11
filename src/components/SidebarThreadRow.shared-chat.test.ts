// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { SidebarThreadRow } from "./SidebarThreadRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const draw = async (task: { threadId: string; title: string; sharedChat?: true }) => {
  await act(async () => { root.render(createElement(SidebarThreadRow, { task, ownerId: "rooms", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRegenerateTitle: vi.fn(), locale: "en", panel: true })); });
};
const openMenu = async () => {
  const row = host.querySelector<HTMLElement>("[data-thread-row], button")!;
  await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 })); });
  return [...document.querySelectorAll("[data-thread-overlay] button")].map((button) => button.textContent);
};

it("shows a team's shared chat by its name, in the person's language", async () => {
  setLocale("de");
  expect(localizedTaskTitle("Shared chat")).toBe("Gemeinsamer Chat");
  setLocale("en");
  expect(localizedTaskTitle("Shared chat")).toBe("Shared chat");
  await draw({ threadId: "main", title: "Shared chat", sharedChat: true });
  expect(host.textContent).toContain("Shared chat");
});

it("offers no rename on it, by the menu or a double click", async () => {
  await draw({ threadId: "main", title: "Shared chat", sharedChat: true });
  const items = await openMenu();
  expect(items.length).toBeGreaterThan(0);
  expect(items.join(" ")).not.toMatch(/rename/i);
  const row = host.querySelector<HTMLElement>("button")!;
  await act(async () => { row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(host.querySelector("input")).toBeNull();
});

it("still renames any other conversation", async () => {
  await draw({ threadId: "own", title: "Quarter numbers" });
  expect((await openMenu()).join(" ")).toMatch(/rename/i);
});
