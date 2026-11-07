import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { COMPANION_SETTINGS_VERSION, companionDevicesFile, countPairedPhones, phoneLinkStartsAtLaunch, readCompanionSettings } from "./companion-settings.mjs";

const here = { remoteClient: false, serverReady: true, enabled: true, pairedPhones: 1 };

test("the phone link starts at launch only for this computer's own server with a phone paired to it", () => {
  assert.equal(phoneLinkStartsAtLaunch(here), true);
  assert.equal(phoneLinkStartsAtLaunch({ ...here, remoteClient: true }), false, "a desktop that is only a client of another computer");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, serverReady: false }), false, "no server of its own running");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, enabled: false }), false, "the person turned it off");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, pairedPhones: 0 }), false, "on once, but no phone ever paired");
  assert.equal(phoneLinkStartsAtLaunch({ ...here, pairedPhones: null }), false, "the paired list could not be read");
});

test("settings from before the switch keep the phone link only with a paired phone, and Tailscale off", () => {
  assert.deepEqual(readCompanionSettings({ enabled: true, keepAwake: true }, 2), { version: COMPANION_SETTINGS_VERSION, enabled: true, keepAwake: true, tailscale: false });
  assert.deepEqual(readCompanionSettings({ enabled: true }, 0), { version: COMPANION_SETTINGS_VERSION, enabled: false, keepAwake: false, tailscale: false });
  assert.deepEqual(readCompanionSettings({ enabled: true, tailscale: true }, null), { version: COMPANION_SETTINGS_VERSION, enabled: false, keepAwake: false, tailscale: false });
  assert.deepEqual(readCompanionSettings(null, 3), { version: COMPANION_SETTINGS_VERSION, enabled: false, keepAwake: false, tailscale: false });
});

test("current settings are the person's own choices, read as written", () => {
  const written = { version: COMPANION_SETTINGS_VERSION, enabled: true, keepAwake: false, tailscale: true };
  assert.deepEqual(readCompanionSettings(written, 0), written);
  assert.deepEqual(readCompanionSettings({ ...written, tailscale: "yes" }, 0), { ...written, tailscale: false });
});

test("paired phones are counted from the companion's own store", () => {
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
