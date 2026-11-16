// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewStreamControl } from "@/lib/browser-stream-client";
import { NativeSurface } from "./NativeSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let rect = { x: 80, y: 120, width: 900, height: 600 };
let resize: () => void;
let intersect: (visible: boolean) => void;
let take: (event: { token: string }) => void;
const layout = vi.fn();
const unsubscribe = vi.fn();

const control = (controller: PreviewStreamControl["controller"], canOperate = true): PreviewStreamControl => ({
  canOperate, controller, generation: 1, dialog: null,
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  rect = { x: 80, y: 120, width: 900, height: 600 };
  vi.clearAllMocks();
  layout.mockResolvedValue(undefined);
  vi.stubGlobal("ogb", { nativeBrowser: { layout, onTake: (callback: typeof take) => { take = callback; return unsubscribe; } } });
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { intersect = (visible) => callback([{ isIntersecting: visible }]); }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON() {},
  }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<Parameters<typeof NativeSurface>[0]> = {}) {
  const onTake = vi.fn();
  let current = { token: null as string | null, control: null as PreviewStreamControl | null, visible: true, onTake, label: "Page", ...props };
  const render = (more: Partial<Parameters<typeof NativeSurface>[0]> = {}) => {
    current = { ...current, ...more };
    return act(async () => root.render(createElement(NativeSurface, current)));
  };
  await render();
  await settle();
  const show = async (token = "page-1", controller: PreviewStreamControl["controller"] = "agent") => {
    await render({ token, control: control(controller) });
    await settle();
  };
  return { onTake, render, show };
}

describe("the native browser surface", () => {
  it("lays out an empty host only after the stream supplies its token and ownership", async () => {
    const h = await mount();
    expect(layout).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild?.tagName).toBe("DIV");
    expect(host.firstElementChild?.childNodes).toHaveLength(0);
    await h.show();
    expect(layout).toHaveBeenLastCalledWith({ token: "page-1", bounds: { x: 80, y: 120, width: 900, height: 600 }, visible: true, canInput: false });
    await h.render({ control: control("you") });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, canInput: true }));
    await h.render({ control: control("you", false) });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ canInput: false }));
  });

  it("uses the existing take callback only for its current visible token", async () => {
    const h = await mount();
    await h.show();
    await act(async () => {
      take({ token: "other-page" });
      take({ token: "page-1" });
    });
    expect(h.onTake).toHaveBeenCalledTimes(1);
    await h.render({ visible: false });
    await act(async () => take({ token: "page-1" }));
    expect(h.onTake).toHaveBeenCalledTimes(1);
  });

  it("returns to the existing address control only for a visible matching focus event and unsubscribes retired tokens", async () => {
    let focusAddress!: (event: { token: string }) => void;
    const unsubscribeFocus = vi.fn();
    vi.stubGlobal("ogb", { nativeBrowser: {
      layout,
      onTake: (callback: typeof take) => { take = callback; return unsubscribe; },
      onFocusAddress: (callback: typeof focusAddress) => { focusAddress = callback; return unsubscribeFocus; },
    } });
    const onLeave = vi.fn();
    const h = await mount({ onLeave });
    await h.show();
    await act(async () => {
      focusAddress({ token: "other-page" });
      focusAddress({ token: "page-1" });
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
    await h.render({ visible: false });
    await act(async () => focusAddress({ token: "page-1" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    await h.render({ visible: true });
    const retiredFocus = focusAddress;
    await h.render({ token: "page-2" });
    expect(unsubscribeFocus).toHaveBeenCalledTimes(1);
    await act(async () => {
      retiredFocus({ token: "page-1" });
      focusAddress({ token: "page-1" });
      focusAddress({ token: "page-2" });
    });
    expect(onLeave).toHaveBeenCalledTimes(2);
    await h.render({ token: null });
    expect(unsubscribeFocus).toHaveBeenCalledTimes(2);
    await act(async () => focusAddress({ token: "page-2" }));
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("reports activity only for its visible controlled token and unsubscribes retired activity callbacks", async () => {
    let activity!: (event: { token: string }) => void;
    const unsubscribeActivity = vi.fn();
    vi.stubGlobal("ogb", { nativeBrowser: {
      layout,
      onTake: (callback: typeof take) => { take = callback; return unsubscribe; },
      onActivity: (callback: typeof activity) => { activity = callback; return unsubscribeActivity; },
    } });
    const onActivity = vi.fn();
    const h = await mount({ onActivity });
    await h.show("page-1", "you");
    await act(async () => { activity({ token: "another-page" }); activity({ token: "page-1" }); });
    expect(onActivity).toHaveBeenCalledTimes(1);
    await h.render({ visible: false });
    await act(async () => activity({ token: "page-1" }));
    await h.render({ visible: true, control: control("agent") });
    await act(async () => activity({ token: "page-1" }));
    await h.render({ control: control("you", false) });
    await act(async () => activity({ token: "page-1" }));
    expect(onActivity).toHaveBeenCalledTimes(1);
    const retiredActivity = activity;
    await h.render({ token: "page-2", control: control("you") });
    expect(unsubscribeActivity).toHaveBeenCalledTimes(1);
    await act(async () => { retiredActivity({ token: "page-1" }); activity({ token: "page-2" }); });
    expect(onActivity).toHaveBeenCalledTimes(2);
    await h.render({ token: null });
    expect(unsubscribeActivity).toHaveBeenCalledTimes(2);
    await act(async () => activity({ token: "page-2" }));
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("hides for another viewer, a hidden document, an offscreen host and an open app dialog", async () => {
    const h = await mount();
    await h.show("page-1", "you");
    await h.render({ control: control("another-viewer") });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, canInput: false }));
    await h.render({ control: control("you") });
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => intersect(false));
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    await act(async () => intersect(true));
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    await settle();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    dialog.remove();
    await settle();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, canInput: true }));
    await h.render({ visible: false });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  });

  it("updates moved bounds without duplicate layouts", async () => {
    const h = await mount();
    await h.show();
    const calls = layout.mock.calls.length;
    resize();
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    await settle();
    expect(layout).toHaveBeenCalledTimes(calls);
    rect = { x: 140, y: 160, width: 1100, height: 700 };
    resize();
    await settle();
    expect(layout).toHaveBeenLastCalledWith({ token: "page-1", bounds: rect, visible: true, canInput: false });
  });

  it("stays visible for dormant role dialogs but hides when an app modal becomes active", async () => {
    const container = document.createElement("div");
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    container.append(dialog);
    document.body.append(container);
    const h = await mount();
    for (const attribute of ["hidden", "inert", "aria-hidden"]) {
      container.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
      await h.show();
      await settle();
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
      container.removeAttribute(attribute);
    }
    for (const css of ["display: none", "visibility: hidden"]) {
      container.setAttribute("style", css);
      await settle();
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    }
    container.removeAttribute("style");
    await settle();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    dialog.setAttribute("role", "alertdialog");
    dialog.removeAttribute("aria-modal");
    await settle();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    container.hidden = true;
    await settle();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    container.remove();
  });

  it("hides the old token before replacing it and ignores take events for a retired token", async () => {
    const h = await mount();
    await h.show();
    await h.render({ token: "page-2" });
    expect(layout.mock.calls.slice(-2).map(([value]) => value)).toEqual([
      { token: "page-1", bounds: rect, visible: false, canInput: false },
      { token: "page-2", bounds: rect, visible: true, canInput: false },
    ]);
    const oldTake = take;
    await h.render({ token: null });
    expect(layout).toHaveBeenLastCalledWith({ token: "page-2", bounds: rect, visible: false, canInput: false });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    const calls = layout.mock.calls.length;
    await act(async () => {
      oldTake({ token: "page-2" });
    });
    expect(layout).toHaveBeenCalledTimes(calls);
    expect(h.onTake).not.toHaveBeenCalled();
  });
});
