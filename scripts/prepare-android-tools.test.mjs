import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("rejects Android Platform Tools that do not match the pinned SHA-256", () => {
  const names = {
    darwin: "platform-tools_r37.0.1-darwin.zip",
    linux: "platform-tools_r37.0.1-linux.zip",
    win32: "platform-tools_r37.0.1-win.zip",
  };
  const cache = mkdtempSync(join(tmpdir(), "openmaus-android-tools-test-"));
  try {
    writeFileSync(join(cache, names[process.platform]), "tampered archive");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./prepare-android-tools.mjs", import.meta.url))], {
      encoding: "utf8",
      env: { ...process.env, OMB_ANDROID_PLATFORM_TOOLS_ARCHIVE_DIR: cache },
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /failed SHA-256 verification/);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
