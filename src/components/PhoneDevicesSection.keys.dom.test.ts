// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({ PhoneSetupFlowView: () => null }));
const { PairDeviceDialog } = await import("./PhoneDevicesSection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const off = { on: false, since: null };
const state = (wifiOn: boolean): CompanionState => ({ enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null, notices: [],
  routes: { wifi: wifiOn ? { on: true, since: 1 } : off, relay: off, tailscale: off, https: off } });
let host: HTMLDivElement, root: Root, opener: HTMLButtonElement;
beforeEach(() => {
  setLocale("en");
  opener = document.createElement("button"); document.body.append(opener); opener.focus();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { document.body.innerHTML = ""; });

const open = async (wifiOn: boolean) => {
  const c = { busy: false, act: vi.fn(), useLocal: vi.fn(), start: vi.fn(), cancel: vi.fn() } as unknown as PhoneSetupController;
  const onClose = vi.fn();
  await act(async () => { root.render(createElement(PairDeviceDialog, { c, state: state(wifiOn), onClose })); });
  return { c, onClose, dialog: document.querySelector<HTMLElement>("[data-pair-dialog]")! };
};
const press = async (target: Element, key: string, shiftKey = false) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
};

it("opening the pairing dialog takes focus from the Settings button, Tab stays inside, and closing hands focus back", async () => {
  const { dialog, onClose } = await open(false);
  expect(dialog.contains(document.activeElement)).toBe(true);
  const controls = [...dialog.querySelectorAll<HTMLElement>("input, button")];
  controls.at(-1)!.focus();
  await press(controls.at(-1)!, "Tab");
  expect(document.activeElement).toBe(controls[0]);
  await press(controls[0]!, "Tab", true);
  expect(document.activeElement).toBe(controls.at(-1));
  await press(dialog, "Escape");
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => { root.unmount(); });
  expect(document.activeElement).toBe(opener);
});

it("Escape while the code is showing stops pairing, the same as Done", async () => {
  const { dialog, onClose, c } = await open(true);
  expect(dialog.dataset.pairDialog).toBe("pairing");
  await press(dialog, "Escape");
  expect(c.cancel).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => { root.unmount(); });
});
