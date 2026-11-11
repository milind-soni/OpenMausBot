import { describe, expect, it, vi } from "vitest";

import {
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_TUNNEL_RETIRED_FIELD,
  companionTunnelRetired,
} from "./companion-account-service.mjs";
import { createCompanionE2E } from "./companion-e2e.mjs";
import { createPhoneLinkFact } from "./phone-link-fact.mjs";

const signedIn = { [COMPANION_ACCOUNT_EMAIL_FIELD]: "ada@example.com", [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1" };
const OLD = { id: "a", name: "Old phone", lastSeenAt: 1 };
const NEW = { id: "b", name: "New phone", lastSeenAt: 1, e2eAt: 2 };
const state = (devices) => ({ enabled: true, devices, pairing: null });

function harness(document = { ...signedIn, [COMPANION_TUNNEL_RETIRED_FIELD]: true }) {
  const posted = [];
  const f = { document, proc: { postMessage: (message) => posted.push(message) }, posted };
  f.fact = createPhoneLinkFact({ retired: () => companionTunnelRetired(f.document), server: () => f.proc, log: vi.fn() });
  return f;
}

describe("companionTunnelRetired", () => {
  it("is the account's tunnelRetired: signed in, no address left, and the control plane said retired", () => {
    expect(companionTunnelRetired({ ...signedIn, [COMPANION_TUNNEL_RETIRED_FIELD]: true })).toBe(true);
    expect(companionTunnelRetired(signedIn)).toBe(false);
    expect(companionTunnelRetired({ [COMPANION_TUNNEL_RETIRED_FIELD]: true }), "signed out").toBe(false);
    expect(companionTunnelRetired(null)).toBe(false);
  });
});

describe("the phone link fact for the local server", () => {
  it("tells the server how many paired phones have an older app once the link ended, and only when the number changes", () => {
    const f = harness();
    f.fact.observe(state([OLD, NEW]));
    expect(f.posted).toEqual([{ type: "openmausbot:phone-link", olderPhoneApps: 1 }]);
    f.fact.observe(state([OLD, NEW]));
    expect(f.posted, "the 30-second check with nothing new").toHaveLength(1);
    f.fact.observe(state([NEW, { ...OLD, e2eAt: 3 }]));
    expect(f.posted.at(-1), "the old phone updated and used the encrypted connection").toEqual({ type: "openmausbot:phone-link", olderPhoneApps: 0 });
  });

  it("says 0 while the link was not ended, whatever phones are paired", () => {
    const f = harness(signedIn);
    f.fact.observe(state([OLD]));
    expect(f.posted).toEqual([{ type: "openmausbot:phone-link", olderPhoneApps: 0 }]);
    f.document = { ...signedIn, [COMPANION_TUNNEL_RETIRED_FIELD]: true };
    f.fact.observe(state([OLD]));
    expect(f.posted.at(-1), "the next check after the control plane ended it").toEqual({ type: "openmausbot:phone-link", olderPhoneApps: 1 });
  });

  it("keeps the last readable device list over a sidecar that errs, and tells a restarted server again", () => {
    const f = harness();
    f.fact.observe(state([OLD]));
    f.fact.observe({ enabled: true, devices: [], pairing: null, error: "the companion is not responding" });
    f.fact.observe({ enabled: true, devicesUnreadable: true, devices: [] });
    f.fact.observe(null);
    expect(f.posted).toEqual([{ type: "openmausbot:phone-link", olderPhoneApps: 1 }]);
    f.proc = { postMessage: (message) => f.posted.push(message) };
    f.fact.observe(state([OLD]));
    expect(f.posted, "a new server process").toHaveLength(2);
    f.fact.serverStarted();
    expect(f.posted, "a restart of the same one").toHaveLength(3);
  });

  it("sends nothing with no server running, and survives one that refuses the message", () => {
    const f = harness();
    f.proc = null;
    f.fact.observe(state([OLD]));
    expect(f.posted).toEqual([]);
    f.proc = { postMessage: () => { throw new Error("gone"); } };
    expect(() => f.fact.serverStarted()).not.toThrow();
  });

  it("hears every state the encrypted connection's check reads", async () => {
    const seen = [];
    const e2e = createCompanionE2E({
      readCredentials: () => ({}),
      updateCredentials: async () => {},
      fetchGrant: async () => null,
      companionState: async () => state([OLD]),
      post: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
      onState: (next) => seen.push(next),
    });
    await e2e.reconcile();
    expect(seen).toEqual([state([OLD])]);
  });
});
