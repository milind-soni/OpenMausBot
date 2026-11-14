// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./Avatar", () => ({ MausAvatar: () => createElement("i", { "data-our-mark": "" }) }));

import { setLocale } from "@/lib/i18n";
import { GrokMovePopup, type GrokMovePopupAction } from "./GrokMovePopup";

let root: Root;
let host: HTMLElement;
let onDone: (action: GrokMovePopupAction) => void;
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
const key = (name: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });

beforeEach(async () => {
  setLocale("en");
  onDone = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(GrokMovePopup, { onDone })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the Move from Grok Bot popup", () => {
  it("is the two marks, a title, one sentence, Let's start and Not now, and nothing else", () => {
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector("svg path[fill-rule]"), "Grok Bot's mark").not.toBeNull();
    expect(dialog.querySelector("[data-our-mark]"), "ours").not.toBeNull();
    expect(dialog.querySelector("h2")?.textContent).toBe("Move from Grok Bot");
    expect(dialog.querySelectorAll("p")).toHaveLength(1);
    expect([...dialog.querySelectorAll("button")].map((node) => node.textContent?.trim() || node.getAttribute("aria-label"))).toEqual(["Let's start", "Not now", "Close"]);
    expect(document.activeElement).toBe(button("Let's start"));
  });

  it.each([["Let's start", "start"], ["Not now", "not_now"], ["Close", "close"]] as const)("%s answers %s", async (label, action) => {
    await act(async () => button(label).click());
    expect(onDone).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("Escape closes it, and Tab stays inside", async () => {
    await key("Tab");
    expect(document.activeElement).toBe(button("Not now"));
    await key("Tab", { shiftKey: true });
    await key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("Close"));
    await key("Escape");
    expect(onDone).toHaveBeenCalledExactlyOnceWith("close");
  });

  it("a click outside doesn't end it for good", async () => {
    await act(async () => host.querySelector<HTMLElement>(".ui-scrim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onDone).not.toHaveBeenCalled();
  });
});
