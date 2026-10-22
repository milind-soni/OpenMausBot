// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BotEditorStore, initialState, reducer, type AppState, type useStore } from "@/state/store";
import { SidebarPagesNav } from "./SidebarFooterNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const dispatch = vi.fn();
async function render(density: SidebarDensity, state: Partial<AppState> = {}) {
  const store = { state: { ...initialState, ...state }, dispatch } as unknown as ReturnType<typeof useStore>;
  await act(async () => root.render(createElement(BotEditorStore, { value: store, children: createElement(SidebarPagesNav, { density }) })));
}
const row = (id = "today") => host.querySelector<HTMLButtonElement>(`[data-sidebar-nav="${id}"]`)!;

beforeEach(() => {
  setLocale("en");
  dispatch.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each(["comfortable", "compact", "icons"] as const)("offers Today in every sidebar size and opens the page (%s)", async (density) => {
  await render(density);
  if (density === "icons") expect(row().getAttribute("aria-label")).toBe("Today");
  else expect(row().textContent).toBe("Today");
  expect(row().getAttribute("aria-current")).toBeNull();
  await act(async () => row().click());
  expect(dispatch).toHaveBeenCalledWith({ type: "showToday" });
});

it("marks Today as the current page while it is open", async () => {
  await render("comfortable", { activeView: "today" });
  expect(row().getAttribute("aria-current")).toBe("page");
});

it("opening Today closes the side panels, and choosing a bot leaves it", () => {
  const open = reducer({ ...initialState, settingsOpen: true, pluginsOpen: true }, { type: "showToday" });
  expect(open).toMatchObject({ activeView: "today", settingsOpen: false, pluginsOpen: false });
  expect(reducer(open, { type: "showChat" }).activeView).toBe("chat");
});

it.each(["comfortable", "compact", "icons"] as const)("offers Apps under Today in every sidebar size, carrying the tour's anchor (%s)", async (density) => {
  await render(density);
  if (density === "icons") expect(row("apps").getAttribute("aria-label")).toBe("Apps");
  else expect(row("apps").textContent).toBe("Apps");
  expect(row("apps").getAttribute("data-tour")).toBe("nav-apps");
  expect(row("today").compareDocumentPosition(row("apps")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => row("apps").click());
  expect(dispatch).toHaveBeenCalledWith({ type: "showApps" });
});

it("marks Apps as the current page while it is open", async () => {
  await render("comfortable", { activeView: "apps" });
  expect(row("apps").getAttribute("aria-current")).toBe("page");
  expect(row("today").getAttribute("aria-current")).toBeNull();
});

it("opens the Apps page on its apps, closing the side panels and the Apps dialog", () => {
  const open = reducer({ ...initialState, settingsOpen: true, pluginsOpen: true, pluginsSurface: "mcp" }, { type: "showApps" });
  expect(open).toMatchObject({ activeView: "apps", settingsOpen: false, pluginsOpen: false, pluginsSurface: "apps" });
  expect(reducer(open, { type: "showChat" }).activeView).toBe("chat");
});

it("keeps an Apps request on the Apps page instead of stacking the dialog over it", () => {
  const page = reducer(initialState, { type: "showApps" });
  expect(reducer(page, { type: "togglePlugins", open: true, surface: "mcp" })).toMatchObject({ activeView: "apps", pluginsOpen: false, pluginsSurface: "mcp" });
  expect(reducer(initialState, { type: "togglePlugins", open: true })).toMatchObject({ activeView: "chat", pluginsOpen: true });
});
