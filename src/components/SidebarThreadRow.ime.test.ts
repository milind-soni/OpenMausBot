// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarThreadRow } from "./SidebarThreadRow";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

function startRenaming() {
  const onRename = vi.fn();
  flushSync(() => root.render(createElement(SidebarThreadRow, {
    task: { threadId: "t1", title: "Weekly notes" }, ownerId: "scout", current: false,
    onSelect: vi.fn(), onRename, onDelete: vi.fn(), locale: "en",
  })));
  const row = host.querySelector<HTMLButtonElement>("[data-sidebar-thread-row]")!;
  flushSync(() => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "周报 ni");
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  return { input, onRename };
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

describe("renaming a sidebar thread with an input method", () => {
  it.each(IME)("keeps editing when Enter or Escape belongs to the $name", ({ init }) => {
    const { input, onRename } = startRenaming();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    try {
      press(input, "Enter", init);
      press(input, "Escape", init);
      expect(onRename).not.toHaveBeenCalled();
      expect(host.querySelector("input")).toBe(input);
      expect(input.value).toBe("周报 ni");
      expect(outside).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });

  it("still saves on a plain Enter", () => {
    const { input, onRename } = startRenaming();
    press(input, "Enter");
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" }), "周报 ni");
  });

  it("still cancels on a plain Escape", () => {
    const { input, onRename } = startRenaming();
    press(input, "Escape");
    expect(onRename).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
  });
});
