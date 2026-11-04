// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ landOnSearchHit: vi.fn(async () => undefined) }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: fixture.landOnSearchHit }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: vi.fn(async () => ({ hits: [] })),
    useStore: () => ({ state: original.initialState, dispatch: vi.fn() }),
  };
});

import { ChatFindBar } from "./ChatFindBar";

let root: Root;
let host: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onClose = vi.fn();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function render() {
  flushSync(() => root.render(createElement(ChatFindBar, { threadId: "ime-thread", onClose })));
  return host.querySelector<HTMLInputElement>("input")!;
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => input.dispatchEvent(event));
  return event;
}

describe("Find in chat with an input method", () => {
  it.each([
    { name: "composition", init: { isComposing: true } },
    { name: "IME key code", init: { keyCode: 229 } },
  ])("leaves the Enter that belongs to the $name to the input method", ({ init }) => {
    const input = render();
    const event = press(input, "Enter", init);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the find bar open when Escape only dismisses the candidate list", () => {
    const input = render();
    const onDocumentKey = vi.fn();
    document.addEventListener("keydown", onDocumentKey);
    press(input, "Escape", { isComposing: true });
    document.removeEventListener("keydown", onDocumentKey);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDocumentKey).not.toHaveBeenCalled();
  });

  it("still closes on Escape and takes Enter once the text is committed", () => {
    const input = render();
    expect(press(input, "Enter").defaultPrevented).toBe(true);
    press(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
