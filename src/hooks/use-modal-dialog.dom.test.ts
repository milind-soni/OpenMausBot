// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useModalDialog } from "./use-modal-dialog";

function Dialog() {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, () => {});
  return createElement("div", { ref, role: "dialog", tabIndex: -1 },
    createElement("button", { type: "button" }, "Close"),
    createElement("a", { href: "https://example.com/source" }, "Source"),
    createElement("a", null, "Not a link"),
    createElement("button", { type: "button", hidden: true }, "Hidden"),
    createElement("div", { inert: true }, createElement("button", { type: "button" }, "Inert")),
    createElement("button", { type: "button", tabIndex: -1 }, "Skipped"),
  );
}

let root: Root | null = null;
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const tab = (shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
};
const named = (text: string) => [...document.querySelectorAll<HTMLElement>("button, a")].find((element) => element.textContent === text)!;

describe("modal dialog focus trap", () => {
  it("reaches transcript links and skips hidden, inert and untabbable controls", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root!.render(createElement(Dialog)));

    named("Close").focus();
    expect(tab().defaultPrevented).toBe(false);
    named("Source").focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(named("Close"));
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(named("Source"));
  });
});
