// @vitest-environment happy-dom
// The Simple sidebar's edge bump in a real DOM: it must end up last in <body>, pinned to the sidebar's edge, because
// Electron applies -webkit-app-region rects in document order and the chat header's drag rect comes after the sidebar.
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SidebarEdgeToggle } from "./SidebarSimpleTop";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function Harness({ onToggle }: { onToggle: () => void }) {
  const aside = useRef<HTMLElement>(null);
  return createElement("aside", { ref: aside, "data-sidebar": "" },
    createElement(SidebarEdgeToggle, { collapsed: false, onToggle, anchorRef: aside, style: { WebkitAppRegion: "no-drag" } as never }));
}

it("moves the bump to the end of <body>, pinned to the sidebar's right edge, after mounting", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, width: 288, height: 900, right: this.hasAttribute("data-sidebar") ? 288 : 0, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  const onToggle = vi.fn();
  flushSync(() => root.render(createElement(Harness, { onToggle })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const bump = document.querySelector<HTMLButtonElement>("[data-sidebar-edge-toggle]")!;
  expect(bump.parentElement).toBe(document.body);
  expect(document.body.lastElementChild).toBe(bump);
  expect(bump.className).toContain("fixed");
  expect(bump.style.left).toBe("288px");
  expect(container.querySelector("[data-sidebar-edge-toggle]")).toBeNull();
  flushSync(() => bump.click());
  expect(onToggle).toHaveBeenCalledOnce();
});

it("sits level with the sidebar's top, below a strip shown above the app, at any sidebar width", async () => {
  let top = 0, right = 288;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const sidebar = this.hasAttribute("data-sidebar");
    return { left: 0, top: sidebar ? top : 0, width: sidebar ? right : 0, height: 900, right: sidebar ? right : 0, bottom: 900, x: 0, y: sidebar ? top : 0, toJSON() {} } as DOMRect;
  });
  let resized: (() => void) | null = null;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
  flushSync(() => root.render(createElement(Harness, { onToggle: vi.fn() })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const bump = document.querySelector<HTMLButtonElement>("[data-sidebar-edge-toggle]")!;
  expect(bump.style.top).toBe("14px");
  // My Cloud's two-line strip pushes the sidebar 58px down, and the sidebar is at its narrowest.
  top = 58; right = 240;
  flushSync(() => resized!());
  expect(bump.style.top).toBe("72px");
  expect(bump.style.left).toBe("240px");
});


it("stays out of sight until the sidebar or the bump is hovered, and reports the hover", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, top: 0, width: 280, height: 900, right: 280, bottom: 900, x: 0, y: 0, toJSON() {} }) as DOMRect);
  const onHover = vi.fn();
  function Hidden({ shown }: { shown: boolean }) {
    const aside = useRef<HTMLElement>(null);
    return createElement("aside", { ref: aside }, createElement(SidebarEdgeToggle, { collapsed: false, shown, onHover, onToggle: () => {}, anchorRef: aside }));
  }
  flushSync(() => root.render(createElement(Hidden, { shown: false })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const bump = () => document.querySelector<HTMLButtonElement>("[data-sidebar-edge-toggle]")!;
  expect(bump().className).toContain("opacity-0");
  expect(bump().className).toContain("focus-visible:opacity-100");
  flushSync(() => bump().dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  expect(onHover).toHaveBeenCalledWith(true);
  flushSync(() => root.render(createElement(Hidden, { shown: true })));
  expect(bump().className).toContain("opacity-100");
});
