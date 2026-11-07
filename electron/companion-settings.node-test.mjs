import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPANION_SETTINGS_VERSION, RECENT_DEVICE_MS, anyRouteOn, companionDevicesFile, countPairedPhones, defaultCompanionSettings, directRoutesOn,
  hasTailnetAddress, phoneLinkShouldSleep, phoneLinkStartsAtLaunch, readCompanionSettings, setRoute,
} from "./companion-settings.mjs";

const NOW = 1_800_000_000_000;
const on = (routes) => routes.reduce((settings, route) => setRoute(settings, route, true, { now: NOW }), defaultCompanionSettings());
const here = { remoteClient: false, serverReady: true, settings: on(["wifi"]), pairedPhones: 1 };

test("every way in is off on a new install", () => {
  const settings = readCompanionSettings(null);
  assert.equal(anyRouteOn(settings), false);
  assert.deepEqual(settings.notices, []);
});

test("the phone link starts at launch only for this computer's own server, with a way in on and a device paired", () => {
  assert.equal(phoneLinkStartsAtLaunch(here), true);
  assert.equal(phoneLinkStartsAtLaunch({ ...here, remoteClient: true }), false, "a desktop that is only a client of another computer");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, serverReady: false }), false, "no server of its own running");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, settings: defaultCompanionSettings() }), false, "every way in off");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, pairedPhones: 0 }), false, "on, but nothing paired: it sleeps");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, pairedPhones: null }), false, "the paired list could not be read");
});

test("an empty sidecar sleeps; one with a device or an open code stays", () => {
  assert.equal(phoneLinkShouldSleep({ enabled: true, devices: [], pairing: null }), true);
  assert.equal(phoneLinkShouldSleep({ enabled: true, devices: [{ id: "a" }], pairing: null }), false);
  assert.equal(phoneLinkShouldSleep({ enabled: true, devices: [], pairing: { code: "1" } }), false);
  assert.equal(phoneLinkShouldSleep({ enabled: true, devices: [], pairing: null, devicesUnreadable: true }), false);
  assert.equal(phoneLinkShouldSleep({ enabled: false, devices: [], pairing: null }), false);
});

test("each route is its own switch; turning one off drops its notice", () => {
  let settings = setRoute(defaultCompanionSettings(), "tailscale", true, { now: NOW, name: "mac.tail1.ts.net" });
  assert.deepEqual(directRoutesOn(settings), { wifi: false, tailscale: true });
  assert.deepEqual(settings.routes.tailscale, { on: true, since: NOW, name: "mac.tail1.ts.net" });
  settings = { ...settings, notices: ["tailscale"] };
  settings = setRoute(settings, "tailscale", false);
  assert.deepEqual(settings.routes.tailscale, { on: false, since: null });
  assert.deepEqual(settings.notices, []);
});

const device = (overrides = {}) => ({ id: "d", lastSeenAt: NOW - 60_000, routes: "any", e2eAt: NOW - 1e9, ...overrides });
const migrate = (facts, raw = { enabled: true, keepAwake: true }) => readCompanionSettings(raw, { now: NOW, ...facts });
const kept = (settings) => Object.entries(settings.routes).filter(([, route]) => route.on).map(([name]) => name);

test("the update turns everything off when nothing was paired, and keeps nothing on silently", () => {
  assert.deepEqual(kept(migrate({ devices: [] })), []);
  assert.deepEqual(kept(migrate({ devices: [device()] }, { enabled: false })), []);
  const stale = migrate({ devices: [device({ lastSeenAt: NOW - RECENT_DEVICE_MS - 1 })], tailnetAddress: true, managedAddress: true });
  assert.deepEqual(kept(stale), [], "a device not seen in 30 days keeps nothing on");
});

test("the update keeps on what a recently seen device could use, each with a notice", () => {
  const phone = migrate({ devices: [device()], managedAddress: true });
  assert.deepEqual(kept(phone), ["wifi", "relay", "https"]);
  assert.deepEqual(phone.notices, ["wifi", "relay", "https"]);
  assert.equal(phone.keepAwake, true);
  assert.equal(phone.version, COMPANION_SETTINGS_VERSION);

  assert.deepEqual(kept(migrate({ devices: [device({ routes: "local" })], managedAddress: true })), ["wifi"], "a home-only device keeps Same Wi-Fi only");
  assert.deepEqual(kept(migrate({ devices: [device({ e2eAt: undefined })] })), ["wifi"], "an old app has no relay");
  const tailnet = migrate({ devices: [device({ routes: "local" })], tailnetAddress: true });
  assert.deepEqual(kept(tailnet), ["wifi", "tailscale"]);
  assert.equal(tailnet.routes.tailscale.name, null, "the name is asked for only on Check again");
});

test("settings already in the new shape are read as written", () => {
  const written = { ...on(["relay"]), notices: ["relay", "wifi"] };
  const read = readCompanionSettings(JSON.parse(JSON.stringify(written)), { devices: [device()], tailnetAddress: true });
  assert.deepEqual(kept(read), ["relay"]);
  assert.deepEqual(read.notices, ["relay"], "a notice for a route that is off is dropped");
  assert.equal(readCompanionSettings({ version: COMPANION_SETTINGS_VERSION, routes: { wifi: { on: "yes" } } }).routes.wifi.on, false);
});

test("paired devices are read from the companion's own store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omb-companion-settings-"));
  try {
    const file = companionDevicesFile({ OMB_COMPANION_DIR: dir });
    assert.equal(file, path.join(dir, "devices.json"));
    assert.equal(countPairedPhones(file), 0, "nothing paired yet");
    writeFileSync(file, JSON.stringify({ devices: [{ id: "a" }, { id: "b" }] }));
    assert.equal(countPairedPhones(file), 2);
    writeFileSync(file, "{not json");
    assert.equal(countPairedPhones(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tailscale is seen by its own interface, never by a 100.64/10 address alone", () => {
  assert.equal(hasTailnetAddress({ en0: [{ family: "IPv4", address: "192.168.1.4" }] }), false);
  assert.equal(hasTailnetAddress({ utun4: [{ family: "IPv4", address: "100.101.2.3" }] }), false, "carrier NAT or another VPN");
  assert.equal(hasTailnetAddress({ en0: [{ family: "IPv4", address: "100.80.0.1" }] }), false);
  assert.equal(hasTailnetAddress({ utun4: [{ family: "IPv4", address: "100.101.2.3" }, { family: "IPv6", address: "fd7a:115c:a1e0::1" }] }), true);
  assert.equal(hasTailnetAddress({ tailscale0: [{ family: "IPv4", address: "100.70.0.1" }] }), true);
  assert.equal(hasTailnetAddress({ Tailscale: [{ family: "IPv4", address: "100.70.0.1" }] }), true);
});
