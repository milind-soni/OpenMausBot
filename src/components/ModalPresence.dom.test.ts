// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MENU_MOTION_MS } from "./MenuMotion";
import { ModalPresence } from "./ModalPresence";

it("keeps a closing modal visible but inert until the fade ends, and cancels the exit when reopened", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (open: boolean) => act(async () => {
    root.render(createElement(ModalPresence, { open, children: createElement("div", { role: "dialog" }, "Settings") }));
  });
  const animation = () => host.querySelector("[data-modal-motion]");
  try {
    await render(true);
    expect(animation()?.getAttribute("data-modal-motion")).toBe("in");
    await render(false);
    expect(animation()?.getAttribute("data-modal-motion")).toBe("out");
    expect(animation()?.hasAttribute("inert")).toBe(true);

    await render(true);
    await act(async () => { vi.advanceTimersByTime(MENU_MOTION_MS); });
    expect(animation()?.hasAttribute("inert")).toBe(false);

    await render(false);
    await act(async () => { vi.advanceTimersByTime(MENU_MOTION_MS); });
    expect(animation()).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
