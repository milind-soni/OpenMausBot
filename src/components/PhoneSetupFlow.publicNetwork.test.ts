import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

// Windows Firewall drops a phone's connection on a network Windows calls
// Public, and Windows 11 calls a newly joined Wi-Fi Public. The Wi-Fi QR is
// the one a phone dials on this network, so that panel says what to change.
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
  secondsLeft: 120,
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
  skip: noop,
  act: async () => {},
  accountAct: async () => {},
  ...over,
});

const render = (over: Partial<PhoneSetupController>) =>
  renderToStaticMarkup(createElement(PhoneSetupFlowView, { controller: controller(over), variant: "settings" }));

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
