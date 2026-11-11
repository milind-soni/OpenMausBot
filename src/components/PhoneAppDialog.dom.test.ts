// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { GlassBar } from "./GlassScrollFrame";
import { PhoneAppDialog, type PhoneAppConnect } from "./PhoneAppDialog";

let host: HTMLDivElement;
let root: Root;
const close = vi.fn();

beforeEach(() => {
  setLocale("en");
  close.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function render(open = true, connect: PhoneAppConnect[] = []) {
  flushSync(() => root.render(createElement(GlassBar, {
    edge: "top",
    children: createElement(PhoneAppDialog, { open, onClose: close, connect }),
  })));
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const backdrop = () => dialog()!.parentElement!;
const button = (text: string) => Array.from(dialog()!.querySelectorAll("button")).find(item => item.textContent === text)!;

it("mounts the full-window backdrop outside the sidebar's glass stacking context", () => {
  render();
  expect(backdrop().parentElement).toBe(document.body);
  expect(backdrop().closest("[data-glass-bar]")).toBeNull();
  expect(host.querySelector("[role=dialog]")).toBeNull();
  expect(dialog()!.querySelectorAll("svg"), "no store code to scan: the pairing code is the only one").toHaveLength(0);
  expect([...dialog()!.querySelectorAll("a[data-phone-app]")].map((link) => link.textContent)).toEqual(["App Store", "Android"]);
});

it("also escapes a transformed sidebar's fixed-position containing block", () => {
  host.style.transform = "translateX(0)";
  render();
  expect(backdrop().parentElement).toBe(document.body);
  expect(host.contains(backdrop())).toBe(false);
});

it("focuses Close and keeps the close button and Escape working after portalling", () => {
  render();
  expect(document.activeElement).toBe(button("Close"));
  flushSync(() => button("Close").click());
  expect(close).toHaveBeenCalledTimes(1);
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(close).toHaveBeenCalledTimes(2);
});

it("closes on a backdrop press while a press inside the card leaves it open", () => {
  render();
  flushSync(() => dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(close).not.toHaveBeenCalled();
  flushSync(() => backdrop().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(close).toHaveBeenCalledTimes(1);
});

it("closes before opening the selected pairing destination", () => {
  const select = vi.fn();
  render(true, [{ key: "here", subtitle: "to this computer", onSelect: select }]);
  flushSync(() => dialog()!.querySelector<HTMLButtonElement>("[data-phone-app-connect=here]")!.click());
  expect(close).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledTimes(1);
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
});

it("removes the portal and its Escape handler when closed", () => {
  render();
  render(false);
  expect(dialog()).toBeNull();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).not.toHaveBeenCalled();
});
