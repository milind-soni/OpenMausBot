import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppInstaller } from "./app-install/installer.mjs";
import { macPlistAppId } from "./app-install/launchers.mjs";

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});

test("macOS: a real bundle built in a temporary home is structurally valid", { skip: process.platform !== "darwin" }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "app-install-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), root);
  const home = path.join(root, "home");
  const installer = createAppInstaller({
    platform: "darwin", path, home, userData: path.join(root, "user-data"), fs: fs.promises, run, hostBundleId: "com.openmausbot.app", enabled: true,
  });
  const result = await installer.installApp({ id: "real-test", name: "Real Test" });
  assert.equal(result.ok, true);
  const bundle = path.join(home, "Applications", "MausBot Apps", "Real Test.app");
  assert.equal(result.app.path, bundle);
  const plist = path.join(bundle, "Contents", "Info.plist");
  assert.equal((await run("/usr/bin/plutil", ["-lint", plist])).code, 0);
  assert.equal(macPlistAppId(fs.readFileSync(plist, "utf8")), "real-test");
  const executable = path.join(bundle, "Contents", "MacOS", "launcher");
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(executable, "utf8"), /^#!\/bin\/sh\n/);
  const icns = fs.readFileSync(path.join(bundle, "Contents", "Resources", "AppIcon.icns"));
  assert.equal(icns.toString("latin1", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.deepEqual(fs.readdirSync(path.join(root, "user-data", "app-install")), ["installed.json"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "Applications", "MausBot Apps")), ["Real Test.app"]);

  assert.deepEqual(await installer.uninstallApp("real-test"), { ok: true, removed: true });
  assert.equal(fs.existsSync(bundle), false);
});
