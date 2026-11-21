// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBotListSwipe } from "./use-bot-list-swipe";

let root: Root;
let host: HTMLDivElement;
let stage: HTMLDivElement;
let chat: HTMLElement;
let list: HTMLElement;
const clickRow = vi.fn();

function Fixture({ initiallyOpen, rtl }: { initiallyOpen: boolean; rtl: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const events = useBotListSwipe(true, open, () => setOpen(true), () => setOpen(false));
  return h("div", { ...events, dir: rtl ? "rtl" : "ltr", style: { direction: rtl ? "rtl" : "ltr" }, "data-open": open },
    h("aside", { "data-look": "sidebar" }, h("button", { onClick: clickRow }, "Chat")),
    h("div", { "data-bot-list-trigger-layer": "" }),
    h("div", null, h("section", { "data-bot-list-chat": "" })),
  );
}

function mount(initiallyOpen = false, rtl = false) {
  act(() => root.render(h(Fixture, { initiallyOpen, rtl })));
  stage = host.firstElementChild as HTMLDivElement;
  chat = stage.querySelector("section")!;
  list = stage.querySelector("button")!;
  stage.getBoundingClientRect = () => new DOMRect(0, 0, 360, 800);
  chat.getBoundingClientRect = () => new DOMRect(initiallyOpen ? 360 * (rtl ? -1 : 1) : 0, 0, 360, 800);
  stage.setPointerCapture = vi.fn();
  stage.hasPointerCapture = () => false;
}

function pointer(target: HTMLElement, type: string, x: number, at: number, y = 80, pointerType = "mouse") {
  const event = new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, pointerType, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "timeStamp", { value: at });
  act(() => { target.dispatchEvent(event); });
}

const progress = () => Number(chat.style.getPropertyValue("--drawer-progress"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clickRow.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("follows the mouse one to one, reverses in place, and returns after a short slow drag", () => {
  mount();
  pointer(chat, "pointerdown", 8, 100);
  pointer(stage, "pointermove", 98, 350);
  vi.advanceTimersToNextFrame();
  expect(progress()).toBe(0.25);
  pointer(stage, "pointermove", 62, 550);
  vi.advanceTimersToNextFrame();
  expect(progress()).toBe(0.15);
  pointer(stage, "pointerup", 62, 750);
  expect(stage.dataset.open).toBe("false");
  expect(stage.hasAttribute("data-drawer-dragging")).toBe(false);
  expect(chat.style.getPropertyValue("--drawer-progress")).toBe("");
});

it("commits a quick touch flick even before halfway", () => {
  mount();
  pointer(chat, "pointerdown", 8, 100, 80, "touch");
  pointer(stage, "pointermove", 80, 160, 80, "touch");
  vi.advanceTimersToNextFrame();
  expect(progress()).toBe(0.2);
  pointer(stage, "pointerup", 80, 175, 80, "touch");
  expect(stage.dataset.open).toBe("true");
});

it("closes from the list on a long drag without selecting the row", () => {
  mount(true);
  pointer(list, "pointerdown", 280, 100);
  pointer(stage, "pointermove", 82, 700);
  vi.advanceTimersToNextFrame();
  expect(progress()).toBe(0.45);
  pointer(stage, "pointerup", 82, 810);
  expect(stage.dataset.open).toBe("false");
  list.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(clickRow).not.toHaveBeenCalled();
});

it("uses the right edge in RTL and rolls back a cancelled swipe", () => {
  mount(false, true);
  pointer(chat, "pointerdown", 352, 100, 80, "touch");
  pointer(stage, "pointermove", 100, 300, 80, "touch");
  vi.advanceTimersToNextFrame();
  expect(progress()).toBe(0.7);
  pointer(stage, "pointercancel", 100, 310, 80, "touch");
  expect(stage.dataset.open).toBe("false");
  expect(stage.hasAttribute("data-drawer-dragging")).toBe(false);
});

it.each([[80, 10, 80], [8, 24, 160]])("leaves interior and vertical gestures alone", (x, dx, y) => {
  mount();
  pointer(chat, "pointerdown", x, 100);
  pointer(stage, "pointermove", x + dx, 160, y);
  expect(stage.hasAttribute("data-drawer-dragging")).toBe(false);
  expect(stage.setPointerCapture).not.toHaveBeenCalled();
});

it("paints the latest position once per frame and discards pending updates on release", () => {
  mount();
  const write = vi.spyOn(chat.style, "setProperty");
  const stageWrite = vi.spyOn(stage.style, "setProperty");
  pointer(chat, "pointerdown", 8, 100);
  pointer(stage, "pointermove", 44, 160);
  pointer(stage, "pointermove", 98, 200);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(write).toHaveBeenCalledExactlyOnceWith("--drawer-progress", "0.25");
  expect(stageWrite).not.toHaveBeenCalled();
  const otherLayers = Array.from(stage.querySelectorAll<HTMLElement>("aside, [data-bot-list-trigger-layer]"));
  for (const layer of otherLayers) expect(layer.style.getPropertyValue("--drawer-progress")).toBe("0.25");

  const measure = vi.spyOn(chat, "getBoundingClientRect");
  pointer(stage, "pointermove", 110, 300);
  pointer(stage, "pointerup", 208, 500);
  expect(measure).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledTimes(1);
  expect(stage.dataset.open).toBe("true");
  expect(stage.hasAttribute("data-drawer-dragging")).toBe(false);
  vi.advanceTimersToNextFrame();
  for (const layer of [chat, ...otherLayers]) expect(layer.style.getPropertyValue("--drawer-progress")).toBe("");
});
