// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativeViewOverlayIntersects } from "./local-vm-workspace";
import { useNativeViewObscured } from "./native-view-obscured";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let root: Root;
let mount: HTMLDivElement;
let seen: boolean[];
const boxes = new Map<Element, DOMRect>();
let topmost: (x: number, y: number) => Element | null;

function Probe() {
  seen.push(useNativeViewObscured(false));
  return null;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20)); }); };

beforeEach(() => {
  seen = [];
  boxes.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return boxes.get(this) ?? rect(0, 0, 0, 0); });
  topmost = () => null;
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = (x, y) => topmost(x, y);
  mount = document.createElement("div");
  document.body.append(mount);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function page(html: string) {
  document.body.insertAdjacentHTML("afterbegin", html);
  const host = document.querySelector("[data-native-view-host]")!;
  boxes.set(host, rect(0, 80, 1280, 740));
  root = createRoot(mount);
  return host;
}

describe("what hides a native view", () => {
  it("not the closed menus of the panel's own toolbar", async () => {
    await page(`<div class="toolbar"><details><summary>Menu</summary><div class="absolute z-40" role="menu" style="opacity:1">items</div></details></div><div data-native-view-host></div>`);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    boxes.set(menu, rect(1000, 60, 224, 300));
    topmost = () => menu;
    await act(async () => root.render(createElement(Probe)));
    await settle();
    expect(seen.at(-1)).toBe(false);
  });

  it("an open menu that paints over it", async () => {
    await page(`<div data-native-view-host></div><div class="absolute z-40" role="menu" style="opacity:1">items</div>`);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    boxes.set(menu, rect(1000, 60, 224, 300));
    menu.checkVisibility = () => true;
    topmost = (x, y) => (x >= 1000 && y <= 360 ? menu : document.querySelector("[data-native-view-host]"));
    await act(async () => root.render(createElement(Probe)));
    await settle();
    expect(seen.at(-1)).toBe(true);
  });

  it("not the sidebar and the bars under a maximised panel", async () => {
    await page(`<aside class="absolute z-20" style="opacity:1">sidebar</aside><div class="fixed inset-0 z-50"><div data-native-view-host><span id="page"></span></div></div>`);
    const sidebar = document.querySelector("aside") as HTMLElement;
    boxes.set(sidebar, rect(0, 28, 280, 792));
    sidebar.checkVisibility = () => true;
    topmost = () => document.getElementById("page");
    await act(async () => root.render(createElement(Probe)));
    await settle();
    expect(seen.at(-1)).toBe(false);
  });
});

describe("the Local VM view's rule", () => {
  it("still hides under a visible explicit overlay, or a z-indexed one, where the page cannot hit-test", () => {
    const host = rect(0, 0, 500, 500);
    const over = rect(100, 100, 50, 50);
    expect(nativeViewOverlayIntersects([host], [{ rect: over, explicit: true, visible: true, zIndex: null }])).toBe(true);
    expect(nativeViewOverlayIntersects([host], [{ rect: over, explicit: false, visible: true, zIndex: 20 }])).toBe(true);
    expect(nativeViewOverlayIntersects([host], [{ rect: over, explicit: true, visible: false, zIndex: null }])).toBe(false);
    expect(nativeViewOverlayIntersects([host], [{ rect: over, explicit: true, visible: true, zIndex: null, above: false }])).toBe(false);
  });
});

describe("where the page cannot hit-test", () => {
  it("keeps the rectangle rule for an overlay that takes no pointer events, as a toast", async () => {
    await page(`<div data-native-view-host></div><div class="fixed z-50" role="dialog" style="opacity:1; pointer-events:none">Saved</div>`);
    const toast = document.querySelector('[role="dialog"]') as HTMLElement;
    boxes.set(toast, rect(900, 700, 300, 60));
    topmost = () => document.querySelector("[data-native-view-host]");
    await act(async () => root.render(createElement(Probe)));
    await settle();
    expect(seen.at(-1)).toBe(true);
  });

  it("keeps the rectangle rule", async () => {
    await page(`<div data-native-view-host></div><div class="absolute z-40" role="menu" style="opacity:1">items</div>`);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    boxes.set(menu, rect(1000, 60, 224, 300));
    menu.checkVisibility = () => true;
    topmost = () => null;
    await act(async () => root.render(createElement(Probe)));
    await settle();
    expect(seen.at(-1)).toBe(true);
  });
});
