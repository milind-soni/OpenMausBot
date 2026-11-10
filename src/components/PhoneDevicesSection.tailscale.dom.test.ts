// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanionState } from "./PhoneSetupFlow";

const openExternalLink = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/app-links", () => ({ openExternalLink }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhonesList", () => ({ PhonesList: () => null }));
vi.mock("./PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  companionAccountBridge: () => null,
  usePhoneSetupController: () => ({ state: f.state, busy: false, accountBusy: false, account: null, accountAct: () => undefined, act: vi.fn(), accountError: null, error: null, useLocal: vi.fn(), start: vi.fn(), cancel: vi.fn(), refreshTailscale: vi.fn() }),
  PhoneSetupFlowView: () => "PAIRING_CODE_VIEW",
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));
import { PhoneDevicesSection } from "./PhoneDevicesSection";

const f = vi.hoisted(() => ({ state: null as object | null }));

const off = { on: false, since: null };
const routes = {
  wifi: off,
  relay: off,
  tailscale: off,
  https: off,
};
const state = (overrides: Partial<CompanionState> = {}): CompanionState =>
  ({ enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null, routes, notices: [], ...overrides });

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the Tailscale download affordance", () => {
  it("opens the download through the app's external-link path", async () => {
    f.state = state({ tailscaleProblem: "not-installed" });
    await act(async () => root.render(createElement(PhoneDevicesSection, { simple: false } as never)));
    const get = [...container.querySelectorAll("button")].find((button) => button.textContent === "Get Tailscale");
    expect(get).toBeTruthy();
    await act(async () => get!.click());
    expect(openExternalLink).toHaveBeenCalledWith("https://tailscale.com/download");
  });
});
