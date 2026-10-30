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
  let finishPrepare: (outcome: "ready" | "full") => void = () => {};
  const withHosted = () => ({
    ...companion,
    endpoints: [{ kind: "hosted" as const, url: HOSTED, priority: 0 }],
  });
  const bridge = {
    companion: {
      state: vi.fn(async () => companion),
      start: vi.fn(async () => {
        companion = { ...companion, enabled: true, endpoints: [], lan: "192.168.1.34" };
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
    finishPrepare: (outcome: "ready" | "full") => finishPrepare(outcome),
    alreadyHosted() {
      companion = { ...withHosted(), enabled: true };
      account = { ...account, endpoint: HOSTED };
    },
    stopRetrying() {
      account = { available: true, status: "ready", email: "ada@example.com" };
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
    expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();

    flushSync(() => button("Pair on this Wi-Fi instead")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce();
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
