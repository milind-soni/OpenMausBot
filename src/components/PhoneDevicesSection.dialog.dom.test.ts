// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({ PhoneSetupFlowView: () => createElement("div", { "data-qr": "" }, "QR") }));
const { PairDeviceDialog } = await import("./PhoneDevicesSection");

const on = { on: true, since: 1 };
const state = { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null, notices: [],
  routes: { wifi: on, relay: on, tailscale: { on: false, since: null }, https: { on: false, since: null } } } as unknown as CompanionState;
let root: Root;
let settings: HTMLElement;
let onClose = vi.fn<() => void>();
let cancel = vi.fn<() => void>();

beforeEach(() => {
  // Stands in for Settings: its glass pane (backdrop-filter) is the box a `fixed` child is laid out in.
  settings = document.createElement("div");
  settings.setAttribute("role", "dialog");
  settings.className = "glass-surface";
  document.body.append(settings);
  onClose = vi.fn<() => void>();
  cancel = vi.fn<() => void>();
  const c = { busy: false, act: vi.fn(), useLocal: vi.fn(), start: vi.fn(), cancel } as unknown as PhoneSetupController;
  root = createRoot(settings);
  flushSync(() => root.render(createElement(PairDeviceDialog, { c, state, onClose })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  settings.remove();
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

it("keeps Tab inside the pairing dialog", () => {
  const done = pair().querySelector("button")!;
  done.getClientRects = () => [{}] as unknown as DOMRectList;
  expect(press("Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(done);
  press("Tab", true);
  expect(document.activeElement).toBe(done);
});
