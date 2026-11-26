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
  const result = await installer.installApp({ id: "la_realtest00000000", name: "Real Test" });
  assert.equal(result.ok, true);
  const bundle = path.join(home, "Applications", "MausBot Apps", "Real Test.app");
  assert.equal(result.app.path, bundle);
  const plist = path.join(bundle, "Contents", "Info.plist");
  assert.equal((await run("/usr/bin/plutil", ["-lint", plist])).code, 0);
  assert.equal(macPlistAppId(fs.readFileSync(plist, "utf8")), "la_realtest00000000");
  const executable = path.join(bundle, "Contents", "MacOS", "launcher");
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(executable, "utf8"), /^#!\/bin\/sh\n/);
  const icns = fs.readFileSync(path.join(bundle, "Contents", "Resources", "AppIcon.icns"));
  assert.equal(icns.toString("latin1", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.deepEqual(fs.readdirSync(path.join(root, "user-data", "app-install")), ["installed.json"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "Applications", "MausBot Apps")), ["Real Test.app"]);

  assert.deepEqual(await installer.uninstallApp("la_realtest00000000"), { ok: true, removed: true });
  assert.equal(fs.existsSync(bundle), false);
});

test("macOS: a real Desktop copy built in a temporary home is structurally valid and leaves the launcher alone", { skip: process.platform !== "darwin" }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "app-desktop-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), root);
  const home = path.join(root, "home");
  const desktop = path.join(home, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  const installer = createAppInstaller({
    platform: "darwin", path, home, userData: path.join(root, "user-data"), desktop, fs: fs.promises, run, hostBundleId: "com.openmausbot.app", enabled: true,
  });
  const id = "la_desktoptest00000";
  assert.equal((await installer.installApp({ id, name: "Desk Test" })).ok, true);
  assert.deepEqual(fs.readdirSync(desktop), []);
  const added = await installer.addToDesktop(id);
  assert.equal(added.ok, true);
  assert.equal(added.app.desktop, true);
  const launcher = path.join(home, "Applications", "MausBot Apps", "Desk Test.app");
  const copy = path.join(desktop, "Desk Test.app");
  assert.deepEqual(fs.readdirSync(desktop), ["Desk Test.app"]);
  const plist = path.join(copy, "Contents", "Info.plist");
  assert.equal((await run("/usr/bin/plutil", ["-lint", plist])).code, 0);
  assert.equal(macPlistAppId(fs.readFileSync(plist, "utf8")), id);
  assert.equal(fs.lstatSync(copy).isSymbolicLink(), false);
  const executable = path.join(copy, "Contents", "MacOS", "launcher");
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  assert.equal(fs.readFileSync(executable, "utf8"), fs.readFileSync(path.join(launcher, "Contents", "MacOS", "launcher"), "utf8"));
  const icns = (bundle) => fs.readFileSync(path.join(bundle, "Contents", "Resources", "AppIcon.icns"));
  assert.ok(icns(copy).equals(icns(launcher)));
  assert.equal(icns(copy).toString("latin1", 0, 4), "icns");

  assert.equal((await installer.installApp({ id, name: "Desk Renamed" })).app.desktop, true);
  assert.deepEqual(fs.readdirSync(desktop), ["Desk Renamed.app"]);
  assert.deepEqual(await installer.removeFromDesktop(id), { ok: true, removed: true });
  assert.deepEqual(fs.readdirSync(desktop), []);
  assert.equal(await installer.isInstalled(id), true);
  assert.deepEqual(await installer.uninstallApp(id), { ok: true, removed: true });
  assert.deepEqual(fs.readdirSync(path.join(home, "Applications", "MausBot Apps")), []);
});
