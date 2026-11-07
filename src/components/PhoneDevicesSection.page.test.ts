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
import { PairDeviceDialog, PhoneDevicesSection, reachLine, routeStateText } from "./PhoneDevicesSection";

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
  it("starts with every way in off, nothing paired, and More ways in folded", () => {
    const html = page();
    expect(html).toContain("Let your phone and other computers use this computer.");
    expect(html).toContain(">Pair a device<");
    expect(html).toContain("Nothing paired yet.");
    expect(html).toMatch(/data-route-row="wifi"[\s\S]*?Same Wi-Fi[\s\S]*?Off · Devices on this network[\s\S]*?>Turn on</);
    expect(html).toMatch(/data-route-row="relay"[\s\S]*?Anywhere, through MausBot[\s\S]*?Off · End-to-end encrypted\. MausBot can't read it\./);
    expect(html).toMatch(/<details class="[^"]*">\s*<summary[^>]*>More ways in</);
    expect(html).not.toContain("data-tailscale-status");
  });

  it("shows each route on since its date, waits for a paired device, and unfolds More ways in when one of its routes is on", () => {
    f.state = state({ routes: routes({ wifi: true, tailscale: true }) });
    let html = page();
    expect(html).toMatch(/data-route-row="wifi"[\s\S]*?On · waiting for a paired device/);
    expect(html).toMatch(/<details[^>]*open=""/);
    f.state = state({ enabled: true, routes: routes({ wifi: true }), devices: [phone] });
    html = page();
    expect(html).toContain("Ada's iPhone");
    expect(html).toMatch(/data-route-row="wifi"[\s\S]*?On · since[^<]*Nov[^<]*7[\s\S]*?>Turn off</);
  });

  it("in Simple mode offers to set up a phone, or names the phone and how it reaches this computer", () => {
    expect(page(true)).toMatch(/Use MausBot on your phone[\s\S]*?>Set up</);
    f.state = state({ enabled: true, routes: routes({ wifi: true, relay: true }), devices: [phone] });
    const html = page(true);
    expect(html).toContain("Your phone");
    expect(html).toContain("Reaches this computer on Same Wi-Fi and anywhere through MausBot.");
    expect(html).toContain(">Change<");
    expect(html).toContain(">Pair another device<");
    expect(html).not.toContain('data-route-row="wifi"');
  });
});

describe("Pair a device", () => {
  const dialog = (overrides: Partial<CompanionState> = {}, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(PairDeviceDialog, { c: c(), state: state(overrides), onClose: () => {}, ...props })).replaceAll("&#x27;", "'");

  it("says what it will turn on before anything listens", () => {
    const html = dialog();
    expect(html).toContain('data-pair-dialog="consent"');
    expect(html).toContain("What are you pairing?");
    expect(html).toContain("To reach this computer, MausBot will turn on:");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("You can turn these off any time in Phone &amp; devices.");
    expect(html).not.toContain("PAIRING_CODE_VIEW");
  });

  it("asks a computer only for Same Wi-Fi and points at the other ways in", () => {
    const html = dialog({}, { initialKind: "computer" });
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain("Or use Tailscale or an HTTPS address: More ways in.");
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
