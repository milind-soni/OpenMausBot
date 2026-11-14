// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  windowChrome: "mac-inset" as "mac-inset" | "win-caption" | "native",
  dispatch: vi.fn(),
  activeView: null as string | null,
  webPanelId: null as string | null,
}));
vi.mock("@/lib/chrome-rail", () => ({ useChromeRail: () => ({ available: true, hidden: false }), setChromeRailHidden: () => {}, sayFrameDrawn: () => {} }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("@/lib/place-look", () => ({ usePlaceLook: () => null }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: {}, notifications: [], notificationsOpen: false, activeView: fixture.activeView, webPanelId: fixture.webPanelId }, dispatch: fixture.dispatch }),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { windowChrome: fixture.windowChrome, windowFrame: undefined }, ready: true }),
}));

import { setLocale } from "@/lib/i18n";
import type { WebPanel } from "@/lib/web-panels";
import { setWebPanels } from "@/lib/web-panel-preferences";
import { pagesFitInBar } from "./FrameBarPinnedPages";
import { WindowFrameBar } from "./WindowFrameBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANELS: WebPanel[] = [
  { id: "panel-1", name: "ToolHub", url: "http://127.0.0.1:8998/" },
  { id: "panel-2", name: "Global map", page: { botId: "b", threadId: "t", messageId: "m" } },
];

let host: HTMLDivElement, root: Root | null = null, restoreLayout: (() => void) | null = null;

function rect(width: number, left = 0): DOMRect {
  return { width, height: 28, left, top: 0, right: left + width, bottom: 28, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

/** happy-dom has no layout: give the bar, its place name, the pages wrapper and the hidden row the sizes a window
 * would, so the component's own fit rule runs on real numbers. */
function layout(barWidth: number, placeWidth: number, pagesLeft: number, needed: number) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    if (el.hasAttribute?.("data-window-frame-bar")) return rect(barWidth);
    if (el.hasAttribute?.("data-window-place")) return rect(placeWidth, (barWidth - placeWidth) / 2);
    if (el.hasAttribute?.("data-frame-bar-pages-measure")) return rect(needed);
    if (el.hasAttribute?.("data-frame-bar-pages")) return rect(22, pagesLeft);
    return original.call(this);
  };
  restoreLayout = () => { Element.prototype.getBoundingClientRect = original; };
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  fixture.dispatch.mockClear();
  fixture.activeView = null;
  fixture.webPanelId = null;
  setWebPanels([]);
  Object.assign(window, { ogb: { workspaces: { state: async () => ({ local: true, name: "This computer" }), onChanged: () => () => {}, menu: async () => {} } } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  restoreLayout?.();
  restoreLayout = null;
  setWebPanels([]);
  delete (window as { ogb?: unknown }).ogb;
});

async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root!.render(element));
  await act(async () => { await Promise.resolve(); });
}

const byText = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === text);

describe("pinned pages in the window's top bar", () => {
  it("draws nothing until a page is pinned, so the bar is the official one", async () => {
    await mount(createElement(WindowFrameBar));
    expect(host.querySelector("[data-frame-bar-pages]")).toBeNull();
    expect([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Hide your computers", "Settings"]);
  });

  it("fits every name in the bar's free half and opens the page its name belongs to", async () => {
    setWebPanels(PANELS);
    layout(1400, 200, 104, 300);
    await mount(createElement(WindowFrameBar));
    const named = [...host.querySelectorAll<HTMLElement>("[data-frame-bar-page]")];
    expect(named.map((button) => button.getAttribute("aria-label"))).toEqual(["ToolHub", "Global map"]);
    expect(host.querySelector("[data-frame-bar-pages] [aria-haspopup]"), "no button while every name fits").toBeNull();
    await act(async () => named[1].click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showWebPanel", id: "panel-2" });
  });

  it("folds into one button when the names would push the place name off the bar's middle", async () => {
    setWebPanels(PANELS);
    layout(700, 200, 104, 300);
    await mount(createElement(WindowFrameBar));
    expect(host.querySelector("[data-frame-bar-page]")).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>("[data-frame-bar-pages] [aria-haspopup]")!;
    expect(trigger.getAttribute("aria-label")).toBe("Custom pages");
    await act(async () => trigger.click());
    await act(async () => { await Promise.resolve(); });
    const toolHub = byText("ToolHub");
    expect(toolHub, "the menu lists the pages by name").toBeTruthy();
    await act(async () => toolHub!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showWebPanel", id: "panel-1" });
  });

  it("decides again once main names the place, which arrives after the bar draws", async () => {
    setWebPanels(PANELS);
    layout(1400, 1200, 104, 300);
    let answer: (place: unknown) => void = () => {};
    const pending = new Promise((resolve) => { answer = resolve; });
    Object.assign(window, { ogb: { workspaces: { state: () => pending, onChanged: () => () => {}, menu: async () => {} } } });
    await mount(createElement(WindowFrameBar));
    expect(host.querySelector("[data-frame-bar-page]"), "no place name yet: the names fit").toBeTruthy();
    await act(async () => { answer({ local: true, name: "This computer" }); await pending; });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("[data-frame-bar-page]"), "with the place name in, the names fold into one button").toBeNull();
    expect(host.querySelector("[data-frame-bar-pages] [aria-haspopup]")).toBeTruthy();
  });

  it("names the open page", async () => {
    setWebPanels(PANELS);
    fixture.activeView = "web-panel";
    fixture.webPanelId = "panel-1";
    layout(1400, 200, 104, 300);
    await mount(createElement(WindowFrameBar));
    expect(host.querySelector("[data-frame-bar-page='panel-1']")!.className).toContain("text-accent");
    expect(host.querySelector("[data-frame-bar-page='panel-2']")!.className).not.toContain("text-accent");
  });
});

describe("the bar's fit rule", () => {
  it("keeps names only while the bar's free half holds them all, with room before the place name", () => {
    expect(pagesFitInBar(1400, 200, 104, 300)).toBe(true);
    expect(pagesFitInBar(1400, 200, 104, 600)).toBe(false);
    expect(pagesFitInBar(700, 200, 104, 300)).toBe(false);
    expect(pagesFitInBar(0, 0, 0, 300), "no layout yet reads as no room").toBe(false);
    expect(pagesFitInBar(1400, 200, 104, 0), "nothing measured yet reads as no room").toBe(false);
  });
});
