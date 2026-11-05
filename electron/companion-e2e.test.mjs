import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createCompanionE2E, deviceCounts, relayNeed } from "./companion-e2e.mjs";
import {
  E2E_TRANSPORT_KEY_FIELD,
  companionE2EMessage,
  createE2EIdentity,
  readE2EIdentity,
  withE2EIdentity,
} from "./e2e-identity.mjs";
import { createRelayTokenService, validRelayGrant } from "./relay-token.mjs";

const HOST_ID = "lz81isB3BuNV6rHgYgG3Wg";
const grant = (overrides = {}) => ({
  token: "eyJ2IjoxfQ.c2lnbmF0dXJl",
  hostId: HOST_ID,
  nodes: ["relay1.openmausbot.com", "relay2.openmausbot.com"],
  expiresAt: 10 * 60 * 60_000,
  refreshAfter: 60 * 60_000,
  ...overrides,
});

describe("the connection key", () => {
  it("is a P-256 key whose public half is rebuilt from the private one before it is trusted", () => {
    const identity = createE2EIdentity();
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(Buffer.from(identity.privateKey, "base64url"));
    expect(Buffer.from(identity.publicKey, "base64url")).toEqual(curve.getPublicKey(undefined, "uncompressed"));
    const document = withE2EIdentity({ other: 1 }, identity);
    expect(readE2EIdentity(document)).toEqual(identity);
    expect(document.other).toBe(1);
    const other = createE2EIdentity();
    expect(readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: { ...identity, publicKey: other.publicKey } })).toBeNull();
    expect(readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: { ...identity, version: 2 } })).toBeNull();
    expect(readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: { ...identity, privateKey: `${identity.privateKey}=` } })).toBeNull();
  });

  it("goes to the sidecar with the relay identity only once the computer holds a token", () => {
    const identity = createE2EIdentity();
    expect(companionE2EMessage(identity, null)).toEqual({ type: "openmausbot:companion-e2e", transportKey: identity.privateKey, relay: null });
    expect(companionE2EMessage(identity, grant()).relay).toEqual({ hostId: HOST_ID, nodes: grant().nodes, relayToken: grant().token });
    expect(companionE2EMessage(null, grant())).toEqual({ type: "openmausbot:companion-e2e", transportKey: null, relay: null });
  });
});

function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (callback, milliseconds) => {
      const id = next++;
      pending.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    async fireAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("relay tokens", () => {
  it("refuses a grant with any field off", () => {
    expect(validRelayGrant(grant())).toEqual(grant());
    for (const bad of [{ token: "no-dot" }, { hostId: "short" }, { nodes: ["relay.example.com"] }, { nodes: [] }, { refreshAfter: 11 * 60 * 60_000 }]) {
      expect(validRelayGrant(grant(bad))).toBeNull();
    }
  });

  it("fetch at once, refresh after refreshAfter, and keep a valid token through a failed refresh", async () => {
    const timers = manualTimers();
    const grants = [];
    const answers = [() => grant(), () => Promise.reject(Object.assign(new Error("down"), { code: "network_unavailable" })), () => grant({ token: "eyJ2IjoyfQ.c2ln" })];
    const fetchGrant = vi.fn(async () => answers.shift()());
    const service = createRelayTokenService({ fetchGrant, onGrant: (next) => grants.push(next), ...timers, now: () => 0, random: () => 0.5 });
    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(grants).toEqual([grant()]);
    expect([...timers.pending.values()][0].milliseconds).toBe(60 * 60_000);
    await timers.fireAll();
    expect(grants).toHaveLength(1);
    expect([...timers.pending.values()][0].milliseconds).toBe(60_000);
    await timers.fireAll();
    expect(grants.at(-1).token).toBe("eyJ2IjoyfQ.c2ln");
    service.stop();
    expect(grants.at(-1)).toBeNull();
  });

  it("drop the token and wait half an hour when the relay is off for this computer", async () => {
    const timers = manualTimers();
    const grants = [];
    const answers = [() => grant(), () => Promise.reject(Object.assign(new Error("off"), { code: "relay_unavailable", status: 503 }))];
    const service = createRelayTokenService({ fetchGrant: async () => answers.shift()(), onGrant: (next) => grants.push(next), ...timers, now: () => 0, random: () => 0.5 });
    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await service.refreshNow();
    expect(grants).toEqual([grant(), null]);
    expect([...timers.pending.values()][0].milliseconds).toBe(30 * 60_000);
    service.stop();
  });
});

describe("the desktop's end-to-end connection", () => {
  it("counts devices for the adoption gates and knows when the relay is needed", () => {
    const state = { enabled: true, pairing: null, devices: [{ e2eAt: 1, routes: "local" }, { routes: "any" }] };
    expect(deviceCounts(state)).toEqual({ e2e: 1, legacy: 1 });
    expect(relayNeed(state)).toBe(true);
    expect(relayNeed({ ...state, devices: [{ routes: "local" }] })).toBe(false);
    expect(relayNeed({ ...state, devices: [], pairing: { token: "t" } })).toBe(true);
    expect(relayNeed({ enabled: false })).toBe(false);
    expect(relayNeed({ enabled: true, error: "x" })).toBeNull();
  });

  it("makes the key on the first relay token, tells the sidecar, and keeps it on after the token goes", async () => {
    let document = {};
    const posted = [];
    let answer = grant();
    const e2e = createCompanionE2E({
      readCredentials: () => document,
      updateCredentials: async (derive) => {
        document = derive(document);
      },
      fetchGrant: async () => (answer instanceof Error ? Promise.reject(answer) : answer),
      companionState: async () => ({ enabled: true, devices: [], pairing: { token: "t" } }),
      post: (message) => posted.push(message),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    expect(e2e.enabled).toBe(false);
    expect(e2e.message()).toBeNull();
    await e2e.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(e2e.enabled).toBe(true);
    expect(readE2EIdentity(document)?.publicKey).toBe(e2e.publicKey);
    expect(posted.at(-1)).toMatchObject({ type: "openmausbot:companion-e2e", relay: { hostId: HOST_ID } });
    answer = Object.assign(new Error("off"), { code: "relay_unavailable" });
    e2e.tokenRejected();
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted.at(-1)).toEqual({ type: "openmausbot:companion-e2e", transportKey: readE2EIdentity(document).privateKey, relay: null });
    e2e.resumed();
    expect(posted.at(-1)).toEqual({ type: "openmausbot:companion-e2e-redial" });
    e2e.stop();
  });

  it("stays dark while the control plane never admits this computer", async () => {
    const posted = [];
    const e2e = createCompanionE2E({
      readCredentials: () => ({}),
      updateCredentials: async () => {},
      fetchGrant: async () => Promise.reject(Object.assign(new Error("off"), { code: "relay_unavailable" })),
      companionState: async () => ({ enabled: true, devices: [], pairing: { token: "t" } }),
      post: (message) => posted.push(message),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await e2e.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(e2e.enabled).toBe(false);
    expect(posted).toEqual([]);
    e2e.stop();
  });
});
