// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useDialogResize } from "./use-dialog-resize";

it("animates both dialog dimensions in either direction and honors reduced motion", () => {
  let notify = () => {};
  let width = 400;
  let height = 180;
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null as (() => void) | null }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notify = callback; }
    observe() {}
    disconnect() {}
  });
  function Preview() {
    const ref = useRef<HTMLDivElement>(null);
    useDialogResize(ref);
    return createElement("div", { ref: (element: HTMLDivElement | null) => {
      ref.current = element;
      if (!element) return;
      Object.defineProperties(element, {
        offsetWidth: { get: () => width },
        offsetHeight: { get: () => height },
        animate: { value: animate },
      });
    } });
  }
  const root = createRoot(document.createElement("div"));
  try {
    flushSync(() => root.render(createElement(Preview)));
    notify();
    expect(animate).not.toHaveBeenCalled();

    width = 680;
    height = 520;
    notify();
    expect(animate).toHaveBeenLastCalledWith([
      { width: "400px", height: "180px" },
      { width: "680px", height: "520px" },
    ], expect.objectContaining({ duration: 240 }));
    animate.mock.results[0]!.value.onfinish?.();

    width = 420;
    height = 200;
    notify();
    expect(animate).toHaveBeenLastCalledWith([
      { width: "680px", height: "520px" },
      { width: "420px", height: "200px" },
    ], expect.objectContaining({ duration: 240 }));
    animate.mock.results[1]!.value.onfinish?.();

    document.documentElement.dataset.reducedMotion = "true";
    height = 500;
    notify();
    expect(animate).toHaveBeenCalledTimes(2);
  } finally {
    flushSync(() => root.unmount());
    delete document.documentElement.dataset.reducedMotion;
    vi.unstubAllGlobals();
  }
});
