import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

const f = vi.hoisted(() => ({ state: null as object | null }));
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
import { OpenCodeRow, PairDeviceDialog, PhoneDevicesSection, reachLine, routeStateText } from "./PhoneDevicesSection";

const off = { on: false, since: null };
const NOV_7 = new Date(2026, 10, 7).getTime();
const routes = (on: Partial<Record<"wifi" | "relay" | "tailscale" | "https", boolean>> = {}) => ({
  wifi: on.wifi ? { on: true, since: NOV_7 } : off,
  relay: on.relay ? { on: true, since: NOV_7 } : off,
  tailscale: on.tailscale ? { on: true, since: NOV_7, name: "mac.tail1.ts.net" } : off,
  https: on.https ? { on: true, since: NOV_7 } : off,
});
const phone = { id: "p1", name: "Ada's iPhone", createdAt: 1, lastSeenAt: Date.now() - 60_000, cloudDesktopAccess: false, routes: "any" as const };
const state = (overrides: Partial<CompanionState> = {}): CompanionState => ({ enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null, routes: routes(), notices: [], ...overrides });
const c = () => ({ busy: false, act: vi.fn(), useLocal: vi.fn(), start: vi.fn(), cancel: vi.fn() }) as unknown as PhoneSetupController;
const page = (simple = false) => renderToStaticMarkup(createElement(PhoneDevicesSection, { simple })).replaceAll("&#x27;", "'");

beforeEach(() => {
  f.state = state();
});

describe("Phone & devices", () => {
  it("with nothing paired and no way in on, shows one task: get the app, then pair, with the ways in folded into one row", () => {
    const html = page(true);
    expect(html).toMatch(/Pair a phone[\s\S]*?data-step-row="1"[\s\S]*?Get the app[\s\S]*?Get for iPhone[\s\S]*?Get for Android[\s\S]*?data-step-row="2"[\s\S]*?Pair[\s\S]*?Then scan the pairing code with the MausBot app\./);
    expect(html.match(/data-phone-pairing-action/g), "exactly one button is the pairing door").toHaveLength(1);
    expect(html).toMatch(/data-phone-pairing-action=""[^>]*>Pair a phone</);
    expect(html).toContain("How your phone reaches this computer");
    expect(html).toContain("Pair a phone turns these on for you. Change them here later.");
    expect(html).not.toContain('data-route-row="wifi"');
    expect(html).not.toContain("Nothing paired yet.");
    expect(html).not.toContain("code</");
  });

  it("is the same page in Advanced, with the ways in open and More ways in under them", () => {
    const html = page(false);
    const simple = page(true);
    expect(simple).toContain("data-reach-fold");
    expect(html).not.toContain("data-reach-fold");
    expect(html).toMatch(/data-route-row="wifi"[\s\S]*?data-route-row="relay"[\s\S]*?Keep this computer awake[\s\S]*?More ways in/);
    expect(html).toContain("Turn on a way for your phone to reach this computer first.");
  });

  it("shows each route on since its date as a switch, and lists paired phones with Pair a phone beside the list", () => {
    f.state = state({ routes: routes({ wifi: true, tailscale: true }) });
    let html = page(true);
    expect(html).toMatch(/Same Wi-Fi[\s\S]*?data-route-row="wifi"[\s\S]*?aria-checked="true"[\s\S]*?On · waiting for a paired device/);
    expect(html).toMatch(/<details[^>]*open=""/);
    f.state = state({ enabled: true, routes: routes({ wifi: true }), devices: [phone] });
    html = page(true);
    expect(html).toContain("Ada's iPhone");
    expect(html).toMatch(/Paired[\s\S]*?>Pair a phone<[\s\S]*?Ada's iPhone/);
    expect(html).toMatch(/On · since[^<]*Nov[^<]*7/);
    expect(html).not.toContain("data-reach-fold");
  });
});

describe("Pair a device", () => {
  const dialog = (overrides: Partial<CompanionState> = {}, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(PairDeviceDialog, { c: c(), state: state(overrides), onClose: () => {}, ...props })).replaceAll("&#x27;", "'");

  it("asks how the phone will reach this computer, with the app's switches, before anything listens", () => {
    const html = dialog();
    expect(html).toContain('data-pair-dialog="consent"');
    expect(html).toContain("Pair a phone with This computer");
    expect(html).toContain("How will your phone reach this computer?");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain(">Turn on and show code<");
    expect(html).toContain("You can turn these off any time in Phone &amp; devices.");
    expect(html).not.toContain("PAIRING_CODE_VIEW");
  });

  it("goes straight to the code when a way in is already on, and says how the device will reach this computer", () => {
    const html = dialog({ routes: routes({ wifi: true }) });
    expect(html).toContain('data-pair-dialog="pairing"');
    expect(html).toContain("PAIRING_CODE_VIEW");
    expect(html).toContain("Reaches this computer on Same Wi-Fi.");
  });
});

describe("route words", () => {
  it("reads a route's state and the reach line in plain words", () => {
    expect(routeStateText(off, 0)).toBe("Off");
    expect(routeStateText({ on: true, since: NOV_7 }, 0)).toBe("On · waiting for a paired device");
    expect(reachLine({ routes: routes() })).toBe("No way in is on yet.");
    expect(reachLine({ routes: routes({ tailscale: true, relay: true }) })).toBe("Reaches this computer on your tailnet and anywhere through MausBot.");
  });
});

describe("open pairing codes", () => {
  it("lists a code still open, until when it works, with Revoke", () => {
    const expiresAt = new Date(2026, 10, 7, 11, 14).getTime();
    const html = renderToStaticMarkup(createElement(OpenCodeRow, { c: c(), state: state({ pairing: { code: "123456", token: "omb_pair_x", expiresAt } }) }));
    expect(html).toMatch(/Pairing code open · works until 11:14/);
    expect(html).toContain(">Revoke<");
    expect(html).not.toContain("123456");
    expect(renderToStaticMarkup(createElement(OpenCodeRow, { c: c(), state: state() }))).toBe("");
  });
});
