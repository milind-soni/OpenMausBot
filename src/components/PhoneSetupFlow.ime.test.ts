// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

const state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [],
  pairing: { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 },
  lan: "192.168.1.34",
};

const noop = () => {};
const controller = (over: Partial<PhoneSetupController>): PhoneSetupController => ({
  state,
  account: { available: true, status: "signed-out" },
  phase: "sign-in",
  email: "ada@example.com",
  code: "",
  codeSent: false,
  busy: false,
  accountBusy: false,
  error: null,
  accountError: null,
  pairingLink: null,
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
  act: async () => null,
  accountAct: async () => {},
  ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function mount(over: Partial<PhoneSetupController> = {}) {
  const requestCode = vi.fn();
  const verifyCode = vi.fn();
  flushSync(() =>
    root.render(createElement(PhoneSetupFlowView, { controller: controller({ requestCode, verifyCode, ...over }) })),
  );
  return { requestCode, verifyCode };
}

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("the sign-in email field with an input method", () => {
  it.each(IME)("does not send a code on the Enter that belongs to the $name", ({ init }) => {
    const { requestCode } = mount();
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="email"]')!;
    expect(input).not.toBeNull();
    press(input, { key: "Enter", ...init });
    expect(requestCode).not.toHaveBeenCalled();
  });

  it("still sends a code on a plain Enter", () => {
    const { requestCode } = mount();
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="email"]')!;
    press(input, { key: "Enter" });
    expect(requestCode).toHaveBeenCalledTimes(1);
  });
});

describe("the sign-in code field with an input method", () => {
  it.each(IME)("does not verify on the Enter that belongs to the $name", ({ init }) => {
    const { verifyCode } = mount({ codeSent: true, code: "12345678" });
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    expect(input).not.toBeNull();
    press(input, { key: "Enter", ...init });
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it("still verifies on a plain Enter", () => {
    const { verifyCode } = mount({ codeSent: true, code: "12345678" });
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    press(input, { key: "Enter" });
    expect(verifyCode).toHaveBeenCalledTimes(1);
  });
});

