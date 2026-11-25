import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhonePairingQr } from "./PhonePairingQr";
import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

// Linux with ufw on and its default "deny incoming": the phone's connection to the device port is dropped, and the
// phone can only say it couldn't reach the computer.
const state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [],
  pairing: { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 },
  lan: "192.168.1.40",
  hostFirewall: "ufw",
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
  pairingLink: "openmausbot://pair?address=192.168.1.40%3A8810",
  address: "192.168.1.40",
  pairingPort: 8810,
  addressText: "192.168.1.40:8810",
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
  act: async () => null,
  accountAct: async () => {},
  ...over,
});

const render = (over: Partial<PhoneSetupController>) =>
  renderToStaticMarkup(createElement(PhoneSetupFlowView, { controller: controller(over) }));
const renderE2E = (over: Partial<PhoneSetupController>) =>
  renderToStaticMarkup(createElement(PhonePairingQr, { c: controller(over), signedIn: false }));

const e2e = (relay: boolean): CompanionState => ({
  ...state,
  e2e: {
    enabled: true,
    relay: relay ? "connected" : "off",
    node: relay ? "relay1.openmausbot.com" : null,
    descriptor: relay ? { v: 1, k: "k", h: "h", r: ["relay1.openmausbot.com"] } : { v: 1, k: "k" },
  },
});

describe("the pairing panel when ufw likely drops the phone", () => {
  it("says so and gives the exact command for the device port", () => {
    for (const html of [render({}), renderE2E({ state: e2e(false) })]) {
      expect(html).toContain("data-host-firewall");
      expect(html).toContain("This computer&#x27;s firewall (ufw) may block your phone on Wi-Fi.");
      expect(html).toContain("turn on Anywhere, through MausBot");
      expect(html).toContain("sudo ufw allow 8810/tcp");
    }
  });

  it("says nothing when the relay carries the pairing, ufw lets it in, the QR is hosted or the code expired", () => {
    expect(renderE2E({ state: e2e(true) })).not.toContain("data-host-firewall");
    for (const over of [{ state: { ...state, hostFirewall: undefined } }, { localFallback: false }, { pairingExpired: true }]) {
      expect(render(over)).not.toContain("data-host-firewall");
    }
  });
});
