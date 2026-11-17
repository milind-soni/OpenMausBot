// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({
  PhoneSetupFlowView: () => createElement("div", { "data-qr": "" }, "QR", createElement("details", null, createElement("summary", null, "Code"))),
}));
const { PairDeviceDialog } = await import("./PhoneDevicesSection");

const on = { on: true, since: 1 };
const state = { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null, notices: [],
  routes: { wifi: on, relay: on, tailscale: { on: false, since: null }, https: { on: false, since: null } } } as unknown as CompanionState;
let root: Root;
let settings: HTMLElement;
let onClose = vi.fn<() => void>();
let cancel = vi.fn<() => void>();
let trigger: HTMLButtonElement;

beforeEach(() => {
  // Stands in for Settings: its glass pane (backdrop-filter) is the box a `fixed` child is laid out in.
  settings = document.createElement("div");
  settings.setAttribute("role", "dialog");
  settings.className = "glass-surface";
  document.body.append(settings);
  trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  onClose = vi.fn<() => void>();
  cancel = vi.fn<() => void>();
  const c = { busy: false, act: vi.fn(), useLocal: vi.fn(), start: vi.fn(), cancel } as unknown as PhoneSetupController;
  root = createRoot(settings);
  flushSync(() => root.render(createElement(PairDeviceDialog, { c, state, onClose })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  settings.remove();
  trigger.remove();
});

const pair = () => document.querySelector<HTMLElement>("[data-pair-dialog]")!;
const press = (key: string, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};

it("shows the pairing QR over the whole window, not inside the Settings glass pane", () => {
  expect(pair().querySelector("[data-qr]")).not.toBeNull();
  expect(settings.contains(pair())).toBe(false);
  expect(pair().parentElement).toBe(document.body);
});

it("closes only the pairing dialog on Escape, so Settings stays open", () => {
  const event = press("Escape");
  expect(event.defaultPrevented).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

// The close ✕ is its own stop; these tests follow Tab between the code and Done.
const hideClose = () => { pair().querySelector<HTMLElement>('[aria-label="Close"]')!.getClientRects = () => [] as unknown as DOMRectList; };

it("keeps Tab inside the pairing dialog", () => {
  hideClose();
  const done = [...pair().querySelectorAll("button")].at(-1)!;
  done.getClientRects = () => [{}] as unknown as DOMRectList;
  pair().querySelector("summary")!.getClientRects = () => [] as unknown as DOMRectList;
  expect(press("Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(done);
  press("Tab", true);
  expect(document.activeElement).toBe(done);
});

it("moves focus into the pairing dialog when it opens and gives it back when it closes", () => {
  expect(pair().contains(document.activeElement)).toBe(true);
  flushSync(() => root.render(null));
  expect(document.activeElement).toBe(trigger);
});

it("lets Tab reach the code details toggle", () => {
  hideClose();
  const summary = pair().querySelector("summary")!;
  const done = [...pair().querySelectorAll("button")].at(-1)!;
  for (const control of [summary, done]) control.getClientRects = () => [{}] as unknown as DOMRectList;
  done.focus();
  press("Tab");
  expect(document.activeElement).toBe(summary);
});
