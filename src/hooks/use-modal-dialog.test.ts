import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));

import { useModalDialog } from "./use-modal-dialog";

class FakeElement extends EventTarget {
  constructor(readonly name: string, readonly parent?: FakeElement) { super(); }
  focus() { document.activeElement = this; }
  hasAttribute() { return false; }
}
class FakeDialog extends FakeElement {
  controls: FakeElement[] = [];
  contains(node: unknown) { return node === this || this.controls.includes(node as FakeElement); }
  querySelectorAll() { return this.controls; }
}
const document = { activeElement: null as FakeElement | null };

function key(target: EventTarget, name: string, patch: { shiftKey?: boolean; prevented?: boolean } = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true, bubbles: true }), { key: name, shiftKey: !!patch.shiftKey });
  if (patch.prevented) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}

let opener: FakeElement;
let dialog: FakeDialog;
let first: FakeElement;
let last: FakeElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let cleanup: () => void;
beforeEach(() => {
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", document);
  opener = new FakeElement("opener");
  dialog = new FakeDialog("dialog");
  first = new FakeElement("close", dialog);
  last = new FakeElement("edit", dialog);
  dialog.controls = [first, last];
  opener.focus();
  onClose = vi.fn<() => void>();
  fixture.effects = [];
  useModalDialog({ current: dialog as unknown as HTMLElement }, onClose);
  cleanup = fixture.effects[0]!() as () => void;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("modal dialog keyboard handling", () => {
  it("moves focus into the dialog and gives it back on close", () => {
    expect(document.activeElement).toBe(dialog);
    cleanup();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape without letting the page see it", () => {
    const page = vi.fn();
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    event.stopPropagation = page;
    dialog.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(page).toHaveBeenCalled();
  });

  it("leaves an Escape that a field inside already handled", () => {
    key(dialog, "Escape", { prevented: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps Tab and Shift-Tab inside the dialog", () => {
    last.focus();
    expect(key(dialog, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(dialog, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // focus on the dialog itself: Shift-Tab goes to the last control
    dialog.focus();
    key(dialog, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
    // a Tab between two controls is the browser's own
    first.focus();
    expect(key(dialog, "Tab").defaultPrevented).toBe(false);
  });
});
