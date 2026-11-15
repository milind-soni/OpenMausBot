// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copied: string[] = [];
vi.mock("@/lib/copy-text", () => ({
  copyText: vi.fn(async (text: string) => {
    copied.push(text);
    return "copied";
  }),
}));

import { setLocale } from "@/lib/i18n";
import type { CompanionState } from "@/lib/companion-types";
import type { CompanionAccountState } from "../types/ogb";
import { PairingFailureCheck, RemoteAccessCheckRow } from "./RemoteAccessCheck";

const state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [{ id: "device-secret-id", name: "Ana's iPhone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false }],
  pairing: { code: "482913", token: "omb_pair_secret", expiresAt: 1 },
  lan: "192.168.1.34",
  endpoints: [{ url: "http://192.168.1.34:8810", kind: "lan", priority: 0 }, { url: "https://c-opaque.openmausbot.com", kind: "hosted", priority: 1 }],
  routes: { wifi: { on: true, since: 1 }, relay: { on: true, since: 1 }, tailscale: { on: false, since: null }, https: { on: false, since: null } },
  e2e: { enabled: true, relay: "connecting", node: null, relayProblem: "no_answer", descriptor: null },
  relayToken: { state: "ready", code: null },
};
const account: CompanionAccountState = { available: true, status: "ready", email: "ada@example.com", endpoint: "https://c-opaque.openmausbot.com" };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  copied.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) ?? null;

describe("the connection check", () => {
  it("in Settings, shows the headline closed, and the steps and Copy diagnostics open", async () => {
    flushSync(() => root.render(createElement(RemoteAccessCheckRow, { account, state })));
    expect(host.querySelector("[data-remote-access-headline]")?.textContent).toBe("MausBot Relay didn't answer.");
    expect(host.querySelector("[data-remote-access-check]")).toBeNull();
    flushSync(() => button("Connection check")!.click());
    const steps = [...host.querySelectorAll("[data-step]")].map((node) => `${node.getAttribute("data-step")}=${node.getAttribute("data-result")}`);
    expect(steps).toEqual(["computer=ok", "account=ok", "relay=failed", "route=ok"]);
    flushSync(() => button("Copy diagnostics")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Copied"));
    expect(copied).toHaveLength(1);
    for (const secret of ["ada@example.com", "c-opaque", "192.168.1.34", "482913", "omb_pair_secret", "device-secret-id", "Ana's iPhone"]) {
      expect(copied[0]).not.toContain(secret);
      expect(host.textContent).not.toContain(secret);
    }
  });

  it("under the pairing screen's failure message, lists the steps without a second headline", () => {
    flushSync(() => root.render(createElement(PairingFailureCheck, { account: { available: false, status: "signed-out" }, state, setupTimedOut: false })));
    expect(host.querySelector("[data-remote-access-headline]")).toBeNull();
    expect(host.querySelector('[data-step="account"]')?.getAttribute("data-result")).toBe("failed");
    expect(host.textContent).toContain("This computer can't reach MausBot right now.");
    expect(button("Copy diagnostics")).not.toBeNull();
  });
});
