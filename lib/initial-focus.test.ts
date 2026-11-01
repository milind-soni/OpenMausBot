import { describe, expect, it, vi } from "vitest";
import { focusInitialInput, isNavigationKey } from "./initial-focus";

function field({ hidden = false, unavailable = false, preferred = false } = {}) {
  return { matches: () => unavailable, getClientRects: () => hidden ? [] : [{}], hasAttribute: () => preferred, focus: vi.fn() };
}
function root(...fields: ReturnType<typeof field>[]) {
  return { querySelectorAll: () => fields } as unknown as HTMLElement;
}

describe("initial input focus", () => {
  it("focuses the preferred editor instead of the first control", () => {
    const search = field(), title = field({ preferred: true });
    expect(focusInitialInput(root(search, title))).toBe(true);
    expect(title.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(search.focus).not.toHaveBeenCalled();
  });
  it("ignores hidden, disabled, and read-only inputs", () => {
    const hidden = field({ hidden: true, preferred: true }), disabled = field({ unavailable: true }), editor = field();
    focusInitialInput(root(hidden, disabled, editor));
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(disabled.focus).not.toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalledOnce();
  });
  it("can retry when an async editor is not mounted yet", () => {
    expect(focusInitialInput(root())).toBe(false);
  });
});

describe("input modality", () => {
  const key = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  it("treats Tab and arrow keys as keyboard navigation", () => {
    for (const name of ["Tab", "ArrowDown", "ArrowLeft", "Home", "End", "PageDown"]) expect(isNavigationKey(key(name))).toBe(true);
    expect(isNavigationKey(key("Tab", { altKey: true }))).toBe(true);
  });
  it("keeps the pointer modality for typing, shortcuts and command chords", () => {
    for (const name of ["r", "c", "f", "Enter", " ", "Escape", "Shift", "Meta"]) expect(isNavigationKey(key(name))).toBe(false);
    expect(isNavigationKey(key("ArrowDown", { metaKey: true }))).toBe(false);
    expect(isNavigationKey(key("Tab", { ctrlKey: true }))).toBe(false);
  });
});
