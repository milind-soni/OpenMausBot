// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_MIN_WIDTH, PANEL_MAX_WIDTH, useComputerPanelResize } from "./computer-panel-resize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let width = 0;
let maxWidth = 0;
// The room the chat and the panel share in the window's row.
let room = 0;
let observers: { notify: () => void; target: HTMLElement; last: number }[] = [];
let handlers: ReturnType<typeof useComputerPanelResize>;

function Panel() {
  handlers = useComputerPanelResize();
  const { panelWidth, maxWidth: max, separatorRef, onSeparatorKeyDown } = handlers;
  width = panelWidth;
  maxWidth = max;
  return createElement("aside", { style: { width: panelWidth } }, createElement("div", { ref: separatorRef, role: "separator", tabIndex: 0, onKeyDown: onSeparatorKeyDown }));
}

function ChatAndPanel({ view = "chat" }: { view?: string }) {
  return createElement("div", null, createElement("main", { key: view }), createElement(Panel));
}

const press = (key: string) => act(() => {
  host.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});

// Like a browser, an observer fires for an element still on the page whose width
// changed, again each time the panel's width changes, until the layout settles.
const resizeWindow = (next: number) => {
  room = next;
  for (let round = 0; round < 10; round++) {
    const before = width;
    act(() => {
      for (const observed of observers) {
        const now = observed.target.offsetWidth;
        if (!observed.target.isConnected || now === observed.last) continue;
        observed.last = now;
        observed.notify();
      }
    });
    if (round > 0 && width === before) return;
  }
  throw new Error("the panel width never settled");
};

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  observers = [];
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private notify: () => void) {}
    observe(target: HTMLElement) { observers.push({ notify: this.notify, target, last: target.offsetWidth }); }
    unobserve(target: HTMLElement) { observers = observers.filter((observed) => observed.notify !== this.notify || observed.target !== target); }
    disconnect() { observers = observers.filter((observed) => observed.notify !== this.notify); }
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    const panel = this.tagName === "ASIDE" ? this : this.parentElement?.querySelector<HTMLElement>(":scope > aside");
    const panelWidth = Number.parseFloat(panel?.style.width ?? "") || 0;
    if (this.tagName === "ASIDE") return panelWidth;
    if (this.tagName === "MAIN") return Math.max(0, room - panelWidth);
    return 0;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the computer panel's resize edge", () => {
  it("widens with the arrow keys, stops at the maximum, and remembers the width", () => {
    localStorage.setItem("omb-computer-panel-width", String(PANEL_MAX_WIDTH - 40));
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(PANEL_MAX_WIDTH - 40);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(width).toBe(PANEL_MAX_WIDTH);
    press("ArrowRight");
    expect(width).toBe(PANEL_MAX_WIDTH - 40);
    expect(localStorage.getItem("omb-computer-panel-width")).toBe(String(PANEL_MAX_WIDTH - 40));
  });

  it("ignores a stored width below the minimum", () => {
    localStorage.setItem("omb-computer-panel-width", "100");
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(400);
  });

  it("grows past 960 px on a wide window, as far as the chat keeping its minimum width allows", () => {
    room = 2000;
    localStorage.setItem("omb-computer-panel-width", "1560");
    act(() => root.render(createElement(ChatAndPanel)));
    expect(width).toBe(1560);
    expect(maxWidth).toBe(2000 - CHAT_MIN_WIDTH);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(width).toBe(2000 - CHAT_MIN_WIDTH);
    expect(localStorage.getItem("omb-computer-panel-width")).toBe(String(2000 - CHAT_MIN_WIDTH));
  });

  it("narrows when the window gets smaller and keeps the narrower width after a key press", () => {
    room = 2000;
    localStorage.setItem("omb-computer-panel-width", "1500");
    act(() => root.render(createElement(ChatAndPanel)));
    expect(width).toBe(1500);
    resizeWindow(1000);
    expect(width).toBe(1000 - CHAT_MIN_WIDTH);
    press("ArrowRight");
    expect(width).toBe(1000 - CHAT_MIN_WIDTH - 40);
    resizeWindow(2000);
    expect(width).toBe(1000 - CHAT_MIN_WIDTH - 40);
  });

  it("returns to the chosen width when the window grows back", () => {
    room = 2000;
    localStorage.setItem("omb-computer-panel-width", "1500");
    act(() => root.render(createElement(ChatAndPanel)));
    resizeWindow(1000);
    expect(width).toBe(1000 - CHAT_MIN_WIDTH);
    resizeWindow(2000);
    expect(width).toBe(1500);
  });

  it("remembers the chosen width, not the narrowed one, after a press on the edge without moving", () => {
    room = 2000;
    localStorage.setItem("omb-computer-panel-width", "1500");
    act(() => root.render(createElement(ChatAndPanel)));
    resizeWindow(1000);
    const edge = { setPointerCapture() {}, releasePointerCapture() {} };
    const pointer = { clientX: 500, pointerId: 1, currentTarget: edge } as unknown as Parameters<typeof handlers.onResizeStart>[0];
    act(() => handlers.onResizeStart(pointer));
    act(() => handlers.onResizeEnd(pointer));
    expect(width).toBe(1000 - CHAT_MIN_WIDTH);
    expect(localStorage.getItem("omb-computer-panel-width")).toBe("1500");
  });

  it("keeps following the window after the chat beside it is replaced by another view", async () => {
    room = 2000;
    act(() => root.render(createElement(ChatAndPanel)));
    expect(maxWidth).toBe(2000 - CHAT_MIN_WIDTH);
    await act(async () => root.render(createElement(ChatAndPanel, { view: "settings" })));
    resizeWindow(3000);
    expect(maxWidth).toBe(3000 - CHAT_MIN_WIDTH);
  });

  it("clamps a stored width wider than the window instead of covering the chat", () => {
    room = 1200;
    localStorage.setItem("omb-computer-panel-width", "5000");
    act(() => root.render(createElement(ChatAndPanel)));
    expect(width).toBe(1200 - CHAT_MIN_WIDTH);
  });
});
