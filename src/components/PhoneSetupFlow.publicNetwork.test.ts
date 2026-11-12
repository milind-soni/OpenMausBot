import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

// Windows Firewall drops a phone's connection on a network Windows calls Public, and Windows 11 calls a newly joined
// Wi-Fi Public.
const state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [],
  pairing: { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 },
  lan: "192.168.1.34",
  publicNetwork: "Wi-Fi",
};

const noop = () => {};
const controller = (over: Partial<PhoneSetupController>): PhoneSetupController => ({
  state,
  account: null,
  phase: "qr",
  email: "",
  code: "",
  codeSent: false,
  busy: false,
  accountBusy: false,
  error: null,
  accountError: null,
  pairingLink: "openmausbot://pair?address=192.168.1.34%3A8810",
  address: "192.168.1.34",
  pairingPort: 8810,
  addressText: "192.168.1.34:8810",
  hostedReady: false,
  localFallback: true,
  tailscaleFallback: false,
  tailscaleAvailable: false,
  pairingExpired: false,
  setupTimedOut: false,
  setEmail: noop,
  setCode: noop,
  changeEmail: noop,
  start: noop,
  useLocal: noop,
  useTailscale: noop,
  refreshTailscale: noop,
  requestCode: noop,
  verifyCode: noop,
  retryAccount: noop,
  cancel: noop,
  refreshCode: noop,
  finish: noop,
  act: async () => {},
  accountAct: async () => {},
  ...over,
});

const render = (over: Partial<PhoneSetupController>) =>
  renderToStaticMarkup(createElement(PhoneSetupFlowView, { controller: controller(over) }));

describe("the Wi-Fi pairing panel on a Windows Public network", () => {
  it("says to set that network to Private", () => {
    const html = render({});
    expect(html).toContain("role=\"note\"");
    expect(html).toContain(
      "Windows has this computer&#x27;s Wi-Fi network set to Public, so its firewall may block your phone.",
    );
    expect(html).toContain("Network &amp; internet → Wi-Fi and set the network profile type to Private.");
  });

  it("says nothing for a hosted QR, a Private network or an expired code", () => {
    for (const over of [
      { localFallback: false },
      { state: { ...state, publicNetwork: undefined } },
      { pairingExpired: true },
    ]) {
      expect(render(over)).not.toContain("set to Public");
    }
  });
});

describe("the pairing code", () => {
  const qrCodes = (html: string) => html.match(/fill="#111111"/g)?.length ?? 0;
  const e2e = { ...state, e2e: { enabled: true, relay: "off" as const, node: null, descriptor: null } };

  it("is the only code on screen and says to scan it inside the app", () => {
    for (const over of [{}, { state: e2e }]) {
      const html = render(over);
      expect(qrCodes(html)).toBe(1);
      expect(html).toContain("Install MausBot on your phone from the App Store or Google Play, then scan this code in the app.");
      expect(html).toContain("Scan it from inside the MausBot app, not the camera.");
    }
  });

  it("names the stores without linking to them", () => {
    for (const over of [{}, { state: e2e }]) {
      const html = render(over);
      expect(html).not.toMatch(/apps\.apple\.com|play\.google\.com|\.apk|<a /);
      expect(html).not.toMatch(/<button[^>]*>(App Store|Google Play)</);
    }
  });

  it("says nothing about scanning once the code expired", () => {
    expect(render({ pairingExpired: true })).not.toContain("scan this code");
  });
});
