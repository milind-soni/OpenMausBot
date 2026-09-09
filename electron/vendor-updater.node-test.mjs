// The vendored electron-updater bundle is a build artifact, but it is also the
// code that actually runs in the packaged app. An AppImage update must land on
// the path the user launches and wait for the old desktop to exit before it
// starts the replacement.
//
// See scripts/patch-appimage-updater.mjs for the reasoning.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchAppImageUpdater } from "../scripts/patch-appimage-updater.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(root, "electron/vendor/electron-updater.cjs"), "utf8");

// Non-global on purpose: a shared /g regex carries lastIndex between .test()
// calls and would report alternating results.
const renamePattern = /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/;

test("the vendored bundle still contains the AppImage installer we patch", () => {
  assert.match(bundle, /const appImageFile = process\.env\["APPIMAGE"\]/);
  assert.match(bundle, /destination = appImageFile;/);
});

test("the install stages the replacement instead of deleting first", () => {
  // Upstream's unlinkSync(appImageFile) runs before the download is even
  // validated. Nothing may remove the running file ahead of the rename.
  assert.doesNotMatch(bundle, /unlinkSync\)\(appImageFile\)/);
  assert.match(bundle, /renameSync\)\(stagedDestination, destination\)/);
});

test("an AppImage update can never be written to a different filename", () => {
  // Upstream renames when the running file has a version in its name, which
  // orphans every .desktop entry, symlink and dock pin pointing at it.
  assert.doesNotMatch(bundle, renamePattern);
});

// The shape of the sites the patch rewrites, as esbuild emits them.
const UPSTREAM = [
  "        (0, fs_1.unlinkSync)(appImageFile);",
  "        let destination;",
  "        const existingBaseName = path2.basename(appImageFile);",
  "        const installerPath = this.installerPath;",
  "        if (path2.basename(installerPath) === existingBaseName || !/\\d+\\.\\d+\\.\\d+/.test(existingBaseName)) {",
  "          destination = appImageFile;",
  "        } else {",
  "          destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
  "        }",
  '        (0, child_process_1.execFileSync)("mv", ["-f", installerPath, destination]);',
  '        this.spawnLog(destination, [], env);',
].join("\n");

test("the patch keeps the running path and never deletes ahead of the rename", () => {
  const patched = patchAppImageUpdater(UPSTREAM);

  assert.doesNotMatch(patched, renamePattern);
  assert.equal(patched.match(/destination = appImageFile;/g)?.length, 2);
  assert.doesNotMatch(patched, /unlinkSync\)\(appImageFile\)/);
  assert.match(patched, /mv", \["-f", installerPath, stagedDestination\]/);
  assert.match(patched, /renameSync\)\(stagedDestination, destination\)/);
  assert.match(patched, /app\.relaunch\(\{ execPath: destination, args: \[\] \}\)/);
  assert.doesNotMatch(patched, /this\.spawnLog\(destination/);
});

test("the patch tolerates esbuild renaming the path import", () => {
  const patched = patchAppImageUpdater(UPSTREAM.replaceAll("path2", "path7"));

  assert.doesNotMatch(patched, renamePattern);
  assert.equal(patched.match(/destination = appImageFile;/g)?.length, 2);
});

test("the patch fails closed when upstream's shape moves", () => {
  // A silent no-op here would ship the launcher-breaking rename again, or
  // reinstate the delete that can cost a user their application.
  for (const [label, mutated] of [
    ["no rename branch", UPSTREAM.replace(/destination = path2\.join[^;]+;/, "destination = elsewhere;")],
    ["no early unlink", UPSTREAM.replace("        (0, fs_1.unlinkSync)(appImageFile);\n", "")],
    ["no move", UPSTREAM.replace(/\(0, child_process_1\.execFileSync\)\("mv"[^;]+;/, "")],
    ["no immediate relaunch", UPSTREAM.replace("this.spawnLog(destination, [], env);", "")],
    ["two rename branches", `${UPSTREAM}\n${UPSTREAM}`],
  ]) {
    assert.throws(() => patchAppImageUpdater(mutated), /to patch, found/, label);
  }
});

test("the shipped installer replaces the AppImage and queues its original path for relaunch", (t) => {
  let relaunched = null;
  let relaunchEnvironment = null;
  const electron = { app: { relaunch(options) {
    relaunched = options;
    relaunchEnvironment = { appImage: process.env.APPIMAGE, silent: process.env.APPIMAGE_SILENT_INSTALL };
    return true;
  } }, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
  t.after(() => {
    Module._load = load;
  });

  const { AppImageUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-install-"));
  const lease = acquireDataDirLease(join(workspace, "data"));
  t.after(() => { lease.release(); rmSync(workspace, { recursive: true, force: true }); });

  // The user launches a versioned filename — the case upstream renames.
  const launched = join(workspace, "OpenMausBot-0.1.43-x86_64.AppImage");
  const staged = join(workspace, "pending", "OpenMausBot-0.1.44-x86_64.AppImage");
  mkdirSync(join(workspace, "pending"));
  writeFileSync(launched, "old", { mode: 0o755 });
  writeFileSync(staged, "new", { mode: 0o755 });

  const previous = process.env.APPIMAGE;
  const previousSilent = process.env.APPIMAGE_SILENT_INSTALL;
  process.env.APPIMAGE = launched;
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  });

  const renames = [];
  AppImageUpdater.prototype.doInstall.call(
    {
      installerPath: staged,
      _logger: { info() {}, warn() {}, error() {}, debug() {} },
      dispatchError: (error) => assert.fail(error),
      emit: (event, value) => renames.push([event, value]),
      spawnLog: () => assert.fail("the replacement must not start before desktop shutdown"),
    },
    { isForceRunAfter: true },
  );

  assert.equal(readFileSync(launched, "utf8"), "new", "the update must land on the launched path");
  assert.equal(existsSync(staged), false, "the staged download must be consumed");
  assert.deepEqual(readdirSync(workspace).sort(), ["OpenMausBot-0.1.43-x86_64.AppImage", "data", "pending"]);
  assert.deepEqual(relaunched, { execPath: launched, args: [] });
  assert.deepEqual(relaunchEnvironment, { appImage: launched, silent: "true" });
  assert.equal(process.env.APPIMAGE_SILENT_INSTALL, previousSilent, "the old process keeps its environment");
  assert.throws(() => acquireDataDirLease(join(workspace, "data")), /already using this data directory/);
  assert.deepEqual(renames, [], "no filename change means no appimage-filename-updated event");
});

test("a rejected AppImage relaunch is reported without quitting the desktop", (t) => {
  const electron = { app: { relaunch: () => false }, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => request === "electron" ? electron : load(request, ...rest);
  t.after(() => { Module._load = load; });
  const { AppImageUpdater, BaseUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-relaunch-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const launched = join(workspace, "OpenMausBot.AppImage");
  const staged = join(workspace, "pending.AppImage");
  writeFileSync(launched, "old");
  writeFileSync(staged, "new");
  const previous = process.env.APPIMAGE;
  const previousSilent = process.env.APPIMAGE_SILENT_INSTALL;
  process.env.APPIMAGE = launched;
  process.env.APPIMAGE_SILENT_INSTALL = "previous";
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
    if (previousSilent === undefined) delete process.env.APPIMAGE_SILENT_INSTALL;
    else process.env.APPIMAGE_SILENT_INSTALL = previousSilent;
  });
  const errors = [];
  const updater = {
    installerPath: staged,
    downloadedUpdateHelper: { downloadedFileInfo: {} },
    _logger: { info() {}, warn() {}, error() {} },
    dispatchError: (error) => errors.push(error.message),
    emit() {},
    doInstall: AppImageUpdater.prototype.doInstall,
    install: BaseUpdater.prototype.install,
    app: { quit: () => assert.fail("a failed relaunch must not quit the desktop") },
  };
  BaseUpdater.prototype.quitAndInstall.call(updater, true, true);
  assert.deepEqual(errors, ["Could not schedule the updated AppImage to restart"]);
  assert.equal(updater.quitAndInstallCalled, false);
  assert.equal(process.env.APPIMAGE_SILENT_INSTALL, "previous");
  assert.equal(readFileSync(launched, "utf8"), "new", "the installed replacement remains available for a manual restart");
});

test("the running AppImage is never removed before its replacement is in place", (t) => {
  const electron = { app: {}, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
  t.after(() => {
    Module._load = load;
  });

  const { AppImageUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const launched = join(workspace, "OpenMausBot-0.1.43-x86_64.AppImage");
  writeFileSync(launched, "the app the user has", { mode: 0o755 });

  const previous = process.env.APPIMAGE;
  process.env.APPIMAGE = launched;
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  });

  // A staged download that is not there stands in for every way the move can
  // fail — a full disk, a cross-filesystem copy cut short, a revoked mount.
  // Upstream unlinks the running file first, so any of those left the user
  // with no application at all.
  assert.throws(() =>
    AppImageUpdater.prototype.doInstall.call(
      {
        installerPath: join(workspace, "never-downloaded.AppImage"),
        _logger: { info() {}, warn() {}, error() {}, debug() {} },
        dispatchError: (error) => {
          throw error;
        },
        emit() {},
        spawnLog: () => assert.fail("a failed install must not relaunch"),
      },
      { isForceRunAfter: true },
    ),
  );

  assert.equal(readFileSync(launched, "utf8"), "the app the user has", "a failed update cost the user their app");
  assert.deepEqual(readdirSync(workspace), [basename(launched)], "a partial download was left behind");
});

const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout?.trim()
  : "";

test("Electron relaunch waits for deferred cleanup and the replacement acquires the same data directory", {
  skip: process.platform === "win32" || (process.platform === "linux" && !process.env.DISPLAY && !xvfb),
  timeout: 20_000,
}, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-relaunch-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const launched = join(workspace, "OpenMausBot-1.0.0.AppImage");
  const staged = join(workspace, "OpenMausBot-2.0.0.AppImage");
  const receipt = join(workspace, "restarted.json");
  const fixture = join(workspace, "main.cjs");
  mkdirSync(join(workspace, "user-data"));
  const leaseModule = new URL("./data-dir-lease.mjs", import.meta.url).href;
  const replacement = `
    const { writeFileSync } = require("node:fs");
    (async () => {
      let parentAlive = true;
      try { process.kill(Number(process.env.OMB_UPDATER_TEST_PARENT), 0); }
      catch (error) { if (error.code === "ESRCH") parentAlive = false; else throw error; }
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      const lease = acquireDataDirLease(${JSON.stringify(join(workspace, "data"))});
      lease.release();
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ parentAlive,
        acquired: true, appImage: process.env.APPIMAGE, silent: process.env.APPIMAGE_SILENT_INSTALL }));
    })().catch(error => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ error: error.message })); process.exitCode = 1; });
  `;
  writeFileSync(launched, "old AppImage", { mode: 0o755 });
  // A disposable executable substitutes for the AppImage payload, not for
  // Electron's native relauncher or the vendored install/quit methods.
  writeFileSync(staged, `#!${process.execPath}\n${replacement}`, { mode: 0o755 });
  writeFileSync(fixture, `
    const { app, autoUpdater } = require("electron");
    const { existsSync } = require("node:fs");
    app.setPath("userData", ${JSON.stringify(join(workspace, "user-data"))});
    app.whenReady().then(async () => {
      if (!app.requestSingleInstanceLock()) throw new Error("fixture lock unavailable");
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      const lease = acquireDataDirLease(${JSON.stringify(join(workspace, "data"))});
      process.env.APPIMAGE = ${JSON.stringify(launched)};
      process.env.OMB_UPDATER_TEST_PARENT = String(process.pid);
      autoUpdater.on("before-quit-for-update", () => app.releaseSingleInstanceLock());
      let cleaned = false;
      app.on("before-quit", event => {
        if (cleaned) return;
        event.preventDefault();
        setTimeout(() => {
          if (existsSync(${JSON.stringify(receipt)})) throw new Error("replacement started during cleanup");
          cleaned = true;
          app.quit();
        }, 250);
      });
      app.on("will-quit", () => lease.release());
      const { AppImageUpdater, BaseUpdater } = require(${JSON.stringify(join(root, "electron/vendor/electron-updater.cjs"))});
      const updater = {
        installerPath: ${JSON.stringify(staged)}, downloadedUpdateHelper: { downloadedFileInfo: {} },
        _logger: { info() {}, warn() {}, error() {} }, emit() {},
        dispatchError(error) { throw error; }, app,
        doInstall: AppImageUpdater.prototype.doInstall, install: BaseUpdater.prototype.install,
        spawnLog() { throw new Error("immediate relaunch bypassed cleanup"); }
      };
      BaseUpdater.prototype.quitAndInstall.call(updater, true, true);
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const electron = createRequire(import.meta.url)("electron");
  const args = ["--no-sandbox", fixture];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(xvfb || electron, xvfb ? ["-a", electron, ...args] : args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, output);
  for (let attempt = 0; !existsSync(receipt) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(receipt), true, `replacement never started: ${output}`);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
    parentAlive: false, acquired: true, appImage: launched, silent: "true",
  });
  assert.equal(readFileSync(launched, "utf8"), `#!${process.execPath}\n${replacement}`);
});
