// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarSectionHeader } from "./SidebarSectionHeader";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function mount(line: boolean, extra: Partial<Parameters<typeof SidebarSectionHeader>[0]> = {}) {
  const naming = { value: "New department", label: "New department name", onCommit: vi.fn(), onCancel: vi.fn() };
  flushSync(() => root.render(createElement(SidebarSectionHeader, {
    name: "Work", collapsed: false, reorderable: true, dragging: false, line, count: 2, onToggle: () => {}, onMenu: () => {}, naming, ...extra,
  })));
  return { naming, field: container.querySelector<HTMLInputElement>("[data-section-name-field]")! };
}
const key = (field: HTMLInputElement, name: string) => flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
const type = (field: HTMLInputElement, text: string) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("a department's name field in its heading", () => {
  for (const line of [true, false]) {
    it(`takes focus with the name selected, in place of the name, its menu and its drag (${line ? "Simple" : "Advanced"})`, () => {
      const { field } = mount(line);
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, "New department".length]);
      expect(field.getAttribute("aria-label")).toBe("New department name");
      expect(field.maxLength).toBe(60);
      expect(container.querySelector("[aria-expanded]")).toBeNull();
      expect(container.querySelector("[draggable]")).toBeNull();
    });
  }

  it("keeps what was typed on Enter, once, even when focus leaves after", () => {
    const { naming, field } = mount(true);
    type(field, "Clients");
    key(field, "Enter");
    flushSync(() => field.blur());
    expect(naming.onCommit.mock.calls).toEqual([["Clients"]]);
    expect(naming.onCancel).not.toHaveBeenCalled();
  });

  it("keeps it when focus leaves, and Escape cancels without keeping it", () => {
    const left = mount(true);
    type(left.field, "Home");
    flushSync(() => left.field.blur());
    expect(left.naming.onCommit.mock.calls).toEqual([["Home"]]);
    flushSync(() => root.unmount());
    root = createRoot(container);
    const escaped = mount(true);
    key(escaped.field, "Escape");
    flushSync(() => escaped.field.blur());
    expect(escaped.naming.onCancel).toHaveBeenCalledOnce();
    expect(escaped.naming.onCommit).not.toHaveBeenCalled();
  });

  it("marks a heading a dragged bot would go into", () => {
    mount(true, { naming: undefined, dropInto: true });
    expect(container.querySelector("[data-section-drop]")?.className).toContain("outline-accent/70");
    flushSync(() => root.unmount());
    root = createRoot(container);
    mount(false, { naming: undefined, dropInto: false });
    expect(container.querySelector("[data-section-drop]")).toBeNull();
  });
});
