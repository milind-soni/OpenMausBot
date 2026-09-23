import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { desktopCapabilities } = require("./capabilities.cjs");

test("a remote server's page is told this computer offers no screen, voice or local control", () => {
  const local = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true } });
  const remote = desktopCapabilities({ platform: "darwin", env: {}, packaged: true, localConnection: { status: "ready", enabled: true }, remote: true });
  assert.equal(local.remote, false);
  assert.equal(local.screenPreview.available, true);
  assert.equal(remote.remote, true);
  assert.deepEqual(remote.screenPreview, { available: false, interaction: "none", reasonCode: "remote-server" });
  assert.equal(remote.dictation.available, false);
  assert.equal(remote.dictation.reasonCode, "remote-server");
  assert.equal(remote.localComputer.available, false);
  assert.equal(remote.localComputer.enabled, false);
  assert.equal(remote.localComputer.reasonCode, "remote-server");
  assert.equal(remote.host.platform, "darwin");
  assert.equal(remote.host.homeDir, "");
  assert.notEqual(local.host.homeDir, "");
});


test("transcription is local-desktop only without changing native call support", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const local = desktopCapabilities({ platform, env: {} });
    assert.equal(local.transcription.available, true);
    assert.equal(local.dictation.available, platform === "darwin");
    const remote = desktopCapabilities({ platform, env: {}, remote: true });
    assert.equal(remote.transcription.available, false);
  }
  assert.equal(desktopCapabilities({ platform: "other", env: {} }).transcription.available, false);
});
