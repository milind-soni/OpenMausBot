import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CONNECTING_DELAY_MS, MIN_VISIBLE_MS, PhoneRow, phoneSubtitle, relayStatusLine, sortPhones, steadyAt } from "./PairedPhones";
import type { CompanionState, PhoneDevice, PhoneSetupController } from "./PhoneSetupFlow";

const NOW = Date.now();
const phone = (extra: Partial<PhoneDevice> = {}): PhoneDevice => ({ id: "phone-1", name: "Ada", createdAt: NOW, lastSeenAt: NOW - 3 * 86_400_000, cloudDesktopAccess: true, ...extra });
const state = (extra: Partial<CompanionState> = {}): CompanionState => ({ enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null, ...extra });
const c = { busy: false, act: async () => {} } as unknown as PhoneSetupController;
const row = (device: PhoneDevice, companion: CompanionState) =>
  renderToStaticMarkup(createElement(PhoneRow, { device, connected: false, state: companion, c, onRemoved: () => {}, defaultOpen: true }));

describe("paired phones", () => {
  it("keeps browser access separately off until granted, including old sidecar snapshots", () => {
    for (const browserControlAccess of [undefined, false, true]) {
      const markup = row(phone({ browserControlAccess }), state());
      expect(markup.match(/<button[^>]*aria-label="Browser control access for Ada"[^>]*>/)?.[0]).toContain(`aria-checked="${browserControlAccess === true}"`);
      expect(markup.match(/<button[^>]*aria-label="Computer view access for Ada"[^>]*>/)?.[0]).toContain('aria-checked="true"');
    }
  });

  it("offers Connect from only once the computer serves the encrypted connection", () => {
    const e2e = { enabled: true, relay: "connected" as const, node: "relay1.openmausbot.com", descriptor: null };
    expect(row(phone(), state())).not.toContain("Connect from");
    const markup = row(phone({ routes: "local" }), state({ e2e }));
    expect(markup).toContain("Connect from");
    expect(markup).toMatch(/aria-checked="true"[^>]*>Wi-Fi and Tailscale only</);
  });

  it("says the live route, or when it was last seen, in one line", () => {
    expect(phoneSubtitle(phone({ route: "relay", e2eAt: NOW }), true, true)).toBe("Connected · Relay");
    expect(phoneSubtitle(phone({ route: "tailscale", routes: "local", e2eAt: NOW }), true, true)).toBe("Connected · Tailscale · Wi-Fi and Tailscale only");
    expect(phoneSubtitle(phone(), true, true)).toBe("Connected · update the app to encrypt");
    expect(phoneSubtitle(phone(), true, false)).toBe("Connected");
    expect(phoneSubtitle(phone(), false, true)).toMatch(/^Last seen /);
  });

  it("lists connected phones first, then the most recently seen", () => {
    const order = sortPhones(
      [phone({ id: "a", lastSeenAt: 3 }), phone({ id: "b", lastSeenAt: 1 }), phone({ id: "c", lastSeenAt: 2 })],
      new Set(["b"]),
    ).map((each) => each.id);
    expect(order).toEqual(["b", "a", "c"]);
  });

  it("shows Connecting only once it lasted 1.5 s, and keeps any line up at least 0.4 s", () => {
    const shown = { text: "Reachable from anywhere · end-to-end encrypted", at: 1_000 };
    expect(steadyAt(shown, 1_100, true)).toBe(1_100 + CONNECTING_DELAY_MS);
    expect(steadyAt(shown, 1_100, false)).toBe(1_000 + MIN_VISIBLE_MS);
    expect(steadyAt({ text: null, at: 0 }, 5_000, false)).toBe(5_000);
    expect(steadyAt(shown, 9_000, false)).toBe(9_000);
  });

  it("names where phones can reach this computer from", () => {
    const e2e = (relay: "connected" | "connecting" | "off") => ({ enabled: true, relay, node: null, descriptor: null });
    expect(relayStatusLine(state())).toBeNull();
    expect(relayStatusLine(state({ e2e: e2e("connected") }))).toBe("Reachable from anywhere · end-to-end encrypted");
    expect(relayStatusLine(state({ e2e: e2e("off") }))).toBe("On this Wi-Fi and Tailscale · end-to-end encrypted");
    expect(relayStatusLine(state({ enabled: false, e2e: e2e("connected") }))).toBeNull();
  });
});
