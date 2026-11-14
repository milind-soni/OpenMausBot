// @vitest-environment happy-dom
// The real controller runs against a fake preload bridge.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
const { PairDeviceDialog } = await import("./PhoneDevicesSection");

const off = { on: false, since: null };
const closed: CompanionState = { enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null,
  routes: { wifi: off, relay: off, tailscale: off, https: off } };

function Page() {
  const c = usePhoneSetupController();
  return c.state ? createElement(PairDeviceDialog, { c, state: c.state, onClose: () => {} }) : null;
}

let host: HTMLDivElement;
let root: Root;
const dialog = () => document.querySelector<HTMLElement>("[data-pair-dialog]");
const turnOn = () => document.querySelector<HTMLButtonElement>("[data-pair-turn-on]");

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

it("stays on the choice and says why when the chosen way in could not be turned on", async () => {
  const companion = {
    state: vi.fn(async () => closed),
    setRoute: vi.fn(async () => { throw new Error("settings not writable"); }),
    start: vi.fn(async () => ({ ...closed, enabled: true })),
    pairing: vi.fn(async () => closed),
    refreshTailscale: vi.fn(async () => closed),
  };
  (globalThis as { ogb?: unknown }).ogb = { companion };
  flushSync(() => root.render(createElement(Page)));
  await vi.waitFor(() => expect(turnOn()?.disabled).toBe(false));
  turnOn()!.click();
  await vi.waitFor(() => expect(companion.setRoute).toHaveBeenCalledWith("wifi", true));
  await vi.waitFor(() => expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Remote access could not be updated. Open Advanced & troubleshooting and try again.",
  ));
  expect(dialog()?.dataset.pairDialog).toBe("consent");
  expect(companion.pairing).not.toHaveBeenCalled();
});
