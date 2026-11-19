// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRightSidePanelEscape } from "./RightSidePanel";

it("routes Escape to the focused panel or the last panel, leaving open menus alone", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const computer = vi.fn();
  const inbox = vi.fn();
  const escape = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  }));
  function Panels() {
    useRightSidePanelEscape("computer", true, computer);
    useRightSidePanelEscape("inbox", true, inbox);
    return [
      createElement("aside", { key: "computer", "data-right-side-panel": "computer" }, createElement("button")),
      createElement("aside", { key: "inbox", "data-right-side-panel": "inbox" }),
    ];
  }
  try {
    await act(async () => root.render(createElement(Panels)));
    expect(escape(document.body)).toBe(false);
    expect(inbox).toHaveBeenCalledOnce();
    expect(computer).not.toHaveBeenCalled();
    expect(escape(host.querySelector("button")!)).toBe(false);
    expect(computer).toHaveBeenCalledOnce();
    host.appendChild(document.createElement("div")).setAttribute("role", "menu");
    expect(escape(document.body)).toBe(true);
    expect(inbox).toHaveBeenCalledOnce();
    expect(computer).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
