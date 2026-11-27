// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarPinnedArea } from "./SidebarPinnedArea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let frameHeight: number;
let measure: () => void;
const pane = () => host.querySelector<HTMLElement>("[data-sidebar-universal-pins]")!;
const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
function render(resizable = true) {
  act(() => root.render(createElement("div", { "data-glass-frame": "" },
    createElement("div", { "data-glass-bar": "top" },
      createElement(SidebarPinnedArea, { resizable, children: "Pinned threads" })),
    createElement("div", { "data-glass-bar": "bottom" }))));
}
function pointer(type: string, y: number) {
  act(() => { handle().dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientY: y, bubbles: true })); });
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
  frameHeight = 800;
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { measure = cb; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => frameHeight);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.glassBar === "top") return 100 + pane().offsetHeight;
    if (this.dataset.glassBar === "bottom") return 80;
    return Math.min(Number.parseFloat(this.style.height) || 180, Number.parseFloat(this.style.maxHeight) || Infinity);
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("drags the divider from the visible height and remembers it when reopened", () => {
  render();
  expect(pane().style.height).toBe("");
  pointer("pointerdown", 240);
  pointer("pointermove", 400);
  pointer("lostpointercapture", 400);
  expect(pane().style.height).toBe("340px");
  render(false);
  expect(handle()).toBeNull();
  render();
  expect(pane().style.height).toBe("340px");
  act(() => { handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
  expect(pane().style.height).toBe("324px");
});

it("reserves room for the rest of the sidebar and adjusts when the window shrinks", () => {
  render();
  pointer("pointerdown", 220);
  pointer("pointermove", 1500);
  expect(pane().style.height).toBe("524px");
  frameHeight = 550;
  act(() => measure());
  expect(pane().style.maxHeight).toBe("274px");
  expect(handle().getAttribute("aria-valuemax")).toBe("274");
  pointer("pointermove", -400);
  expect(pane().style.height).toBe("64px");
});
