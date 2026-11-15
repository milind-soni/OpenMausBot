// @vitest-environment happy-dom
// The real controller and view run against a fake preload bridge.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionAccountState } from "../types/ogb";
import { PhoneSetupFlowView, usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

/** Settings' pairing panel: the flow with its own controller, as CompanionSection mounts it. */
function PhoneSetupFlow() {
  return createElement(PhoneSetupFlowView, { controller: usePhoneSetupController() });
}

const HOSTED = "https://c-opaque.openmausbot.com";
const FULL =
  "Secure HTTPS links are temporarily full. Try again in 10 minutes, or pair on this Wi-Fi or with Tailscale.";

function desktop() {
  let companion: CompanionState = { enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null };
  let account: CompanionAccountState = { available: true, status: "ready", email: "ada@example.com" };
  let finishPrepare: (outcome: "ready" | "full" | "relay") => void = () => {};
  let wifi = true;
  const withHosted = () => ({
    ...companion,
    endpoints: [{ kind: "hosted" as const, url: HOSTED, priority: 0 }],
  });
  const bridge = {
    companion: {
      state: vi.fn(async () => companion),
      start: vi.fn(async () => {
        companion = { ...companion, enabled: true, endpoints: [], lan: wifi ? "192.168.1.34" : null };
        return companion;
      }),
      stop: vi.fn(async () => companion),
      keepAwake: vi.fn(async () => companion),
      refreshTailscale: vi.fn(async () => companion),
      pairing: vi.fn(async (open: boolean) => {
        companion = {
          ...companion,
          pairing: open
            ? { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 }
            : null,
        };
        return companion;
      }),
      cloudDesktop: vi.fn(async () => companion),
      browserControl: vi.fn(async () => companion),
      revoke: vi.fn(async () => companion),
    },
    companionAccount: {
      state: vi.fn(async () => account),
      requestCode: vi.fn(async () => account),
      verifyCode: vi.fn(async () => account),
      retry: vi.fn(async () => account),
      signOut: vi.fn(async () => account),
      prepare: vi.fn(() => new Promise<CompanionAccountState>((resolve) => {
        finishPrepare = (outcome) => {
          if (outcome === "ready") {
            companion = withHosted();
            account = { ...account, endpoint: HOSTED };
          } else if (outcome === "relay") {
            // 409 relay_capable: the stored address is forgotten and phones connect through the relay.
            account = { available: true, status: "ready", email: "ada@example.com" };
          } else {
            account = { available: true, status: "error", email: "ada@example.com", message: FULL };
          }
          resolve(account);
        };
      })),
    },
  };
  return {
    bridge,
    finishPrepare: (outcome: "ready" | "full" | "relay") => finishPrepare(outcome),
    /** Signed in with an address stored from before, which the control plane has since removed. */
    /** No Wi-Fi address on this computer. */
    noWifi() {
      wifi = false;
    },
    /** The first relay token arrived: the encrypted connection is on from now. */
    keyOn() {
      companion = { ...companion, e2e: { enabled: true, relay: "connected" as const, node: null, descriptor: null } };
    },
    staleAddress() {
      account = { ...account, endpoint: HOSTED };
    },
    /** Same Wi-Fi and Anywhere on, as the start without explicit routes turns them on. */
    relayRoute(e2e = false) {
      companion = {
        ...companion,
        routes: {
          wifi: { on: true, since: Date.now() },
          relay: { on: true, since: Date.now() },
          tailscale: { on: false, since: null },
          https: { on: true, since: Date.now() },
        },
        ...(e2e ? { e2e: { enabled: true, relay: "connected" as const, node: null, descriptor: null } } : {}),
      };
    },
    alreadyHosted() {
      companion = { ...withHosted(), enabled: true };
      account = { ...account, endpoint: HOSTED };
    },
    stopRetrying() {
      account = { available: true, status: "ready", email: "ada@example.com" };
    },
    withTailscaleRoute() {
      companion = {
        ...companion,
        routes: {
          wifi: { on: true, since: null },
          relay: { on: false, since: null },
          tailscale: { on: true, since: Date.now(), name: "ada-mac.tail1234.ts.net" },
          https: { on: false, since: null },
        },
      };
    },
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) ?? null;

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

async function startPairing(fake: ReturnType<typeof desktop>) {
  (globalThis as { ogb?: unknown }).ogb = fake.bridge;
  flushSync(() => root.render(createElement(PhoneSetupFlow)));
  await vi.waitFor(() => expect(button("Pair a device")?.disabled).toBe(false));
  button("Pair a device")!.click();
}

describe("pairing on a computer that holds no HTTPS address yet", () => {
  it("creates the address under the spinner, then opens the HTTPS QR", async () => {
    const fake = desktop();
    await startPairing(fake);

    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    expect(fake.bridge.companion.start).toHaveBeenCalledOnce();
    expect(text()).toContain("Creating secure remote access");
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();

    fake.finishPrepare("ready");
    await vi.waitFor(
      () => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    flushSync(() => button("Reveal")!.click());
    expect(text()).toContain(`Pairing address${HOSTED}`);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledTimes(2);
  });

  it("says when to try again when no address is free, and offers Wi-Fi", async () => {
    const fake = desktop();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());

    fake.finishPrepare("full");
    await vi.waitFor(() => expect(text()).toContain(FULL));
    expect(text()).toContain("Secure access needs attention");
    expect(button("Try secure access again")).not.toBeNull();
    expect(button("Pair on this Wi-Fi instead")).not.toBeNull();
    expect(button("Pair using Tailscale")).toBeNull();
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();

    flushSync(() => button("Pair on this Wi-Fi instead")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
  });

  it("offers Tailscale when the route is ready but hosted capacity is full, and opens its QR", async () => {
    const fake = desktop();
    fake.withTailscaleRoute();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());

    fake.finishPrepare("full");
    await vi.waitFor(() => expect(text()).toContain(FULL));
    expect(button("Pair using Tailscale")).not.toBeNull();

    flushSync(() => button("Pair using Tailscale")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(text()).toContain("123456");
    flushSync(() => button("Reveal")!.click());
    expect(text()).toContain("ada-mac.tail1234.ts.net:8810");
  });

  it("asks again when the desktop stopped retrying while pairing still waits", async () => {
    const fake = desktop();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    fake.finishPrepare("full");
    await vi.waitFor(() => expect(text()).toContain(FULL));

    fake.stopRetrying();
    await vi.waitFor(
      () => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(text()).toContain("Creating secure remote access");
    fake.finishPrepare("ready");
    await vi.waitFor(
      () => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull(),
      { timeout: 5_000 },
    );
  });
});

describe("pairing on a computer that already holds its HTTPS address", () => {
  it("opens the QR at once, and tells the desktop someone is pairing over it", async () => {
    const fake = desktop();
    fake.alreadyHosted();
    await startPairing(fake);

    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
  });
});

describe("pairing on a computer the relay carries", () => {
  const qr = () => host.querySelector('[aria-label="Device pairing QR code"]');

  it("opens the code through the relay at once while a stored address is still being checked", async () => {
    const fake = desktop();
    fake.staleAddress();
    fake.relayRoute(true);
    await startPairing(fake);
    // prepare() has not answered: the stored address is neither verified nor forgotten yet, and nothing waits on it.
    await vi.waitFor(() => expect(qr()).not.toBeNull(), { timeout: 5_000 });
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(text()).not.toContain("Creating secure remote access");

    // The control plane answers that the relay carries this computer: the open code stays.
    fake.finishPrepare("relay");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(qr()).not.toBeNull();
    expect(text()).not.toContain("Secure access needs attention");
    expect(fake.bridge.companion.pairing).toHaveBeenCalledOnce();
  });

  it("waits for the HTTPS address, with no plain Wi-Fi code, while the encrypted connection is off", async () => {
    const fake = desktop();
    fake.staleAddress();
    fake.relayRoute(false);
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
    expect(text()).toContain("Creating secure remote access");

    fake.finishPrepare("ready");
    await vi.waitFor(() => expect(qr()).not.toBeNull(), { timeout: 5_000 });
    flushSync(() => button("Reveal")!.click());
    expect(text()).toContain(`Pairing address${HOSTED}`);
  });

  it("waits instead of failing when this computer has no Wi-Fi address", async () => {
    const fake = desktop();
    fake.noWifi();
    fake.staleAddress();
    fake.relayRoute(true);
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
    expect(text()).toContain("Creating secure remote access");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens through the relay without a second click once the address request switches the encrypted connection on", async () => {
    // A stored address that is gone and no installation credential: the request provisions again, which brings the
    // relay token and so the encrypted connection.
    const during = desktop();
    during.staleAddress();
    during.relayRoute(false);
    await startPairing(during);
    await vi.waitFor(() => expect(during.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    expect(during.bridge.companion.pairing).not.toHaveBeenCalled();
    during.keyOn();
    during.finishPrepare("relay");
    await vi.waitFor(() => expect(qr()).not.toBeNull(), { timeout: 5_000 });
    expect(during.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(text()).not.toContain("Secure access needs attention");
    flushSync(() => root.render(null));

    // The relay token lands only after the request answered: the screen opens the code when it does.
    root = createRoot(host);
    const after = desktop();
    after.staleAddress();
    after.relayRoute(false);
    await startPairing(after);
    await vi.waitFor(() => expect(after.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    after.finishPrepare("relay");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(after.bridge.companion.pairing).not.toHaveBeenCalled();
    after.keyOn();
    await vi.waitFor(() => expect(qr()).not.toBeNull(), { timeout: 5_000 });
    expect(after.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(text()).not.toContain("Secure access needs attention");
  });

  it("still waits for an HTTPS address when Anywhere is off", async () => {
    const fake = desktop();
    await startPairing(fake);
    await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
    fake.finishPrepare("relay");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
    expect(text()).toContain("Creating secure remote access");
  });
});
