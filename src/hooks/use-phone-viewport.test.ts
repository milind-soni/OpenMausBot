// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePhoneViewport } from "./use-phone-viewport";

function Shell({ phone }: { phone: boolean }) {
  usePhoneViewport(phone);
  return createElement("textarea");
}

it("follows the visible keyboard area and restores the shell on blur or keyboard dismissal", () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 800);
  let update: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { update = callback; return 1; });
  const host = document.body.appendChild(document.createElement("div"));
  host.id = "root";
  const root = createRoot(host);
  const resize = (height: number, offsetTop: number) => {
    Object.assign(viewport, { height, offsetTop });
    viewport.dispatchEvent(new Event("resize"));
    update(0);
  };
  try {
    flushSync(() => root.render(createElement(Shell, { phone: true })));
    const input = host.querySelector("textarea")!;
    input.focus();
    resize(450, 90);
    expect(host.style.getPropertyValue("--phone-height")).toBe("450px");
    expect(host.style.getPropertyValue("--phone-top")).toBe("90px");
    resize(800, 0);
    expect(host.style.getPropertyValue("--phone-height")).toBe("");
    resize(430, 70);
    input.blur();
    update(0);
    expect(host.style.getPropertyValue("--phone-top")).toBe("");
    expect(host.style.getPropertyValue("--phone-bottom-inset")).toBe("");
    input.focus();
    viewport.scale = 2;
    resize(360, 40);
    expect(host.style.getPropertyValue("--phone-height")).toBe("");
    flushSync(() => root.render(createElement(Shell, { phone: false })));
    expect(host.hasAttribute("data-phone-viewport")).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
