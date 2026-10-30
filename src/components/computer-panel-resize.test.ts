// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PANEL_MAX_WIDTH, useComputerPanelResize } from "./computer-panel-resize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let width = 0;

function Panel() {
  const { panelWidth, separatorRef, onSeparatorKeyDown } = useComputerPanelResize();
  width = panelWidth;
  return createElement("aside", null, createElement("div", { ref: separatorRef, role: "separator", tabIndex: 0, onKeyDown: onSeparatorKeyDown }));
}

const press = (key: string) => act(() => {
  host.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
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

  it("ignores a stored width outside the bounds", () => {
    localStorage.setItem("omb-computer-panel-width", "5000");
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(400);
  });
});
