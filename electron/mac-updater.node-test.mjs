// Exercise the shipped MacUpdater's real authenticated loopback ZIP proxy and
// coordinator together. Only Electron's native updater is fake: no installed
// app, signing identity, account, or live data is touched.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { patchMacUpdater } from "../scripts/patch-mac-updater.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function readHttp(url, headers) {
  return new Promise((resolve, reject) => {
    get(url, { headers, agent: false }, (response) => {
      const bytes = [];
      response.on("data", (chunk) => bytes.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(bytes) }));
    }).on("error", reject);
  });
}

function harness(t, { fetchZip = true } = {}) {
  const native = new EventEmitter();
  const nativeCalled = deferred();
  const transferred = deferred();
  let feed;
  let quitCalls = 0;
  let downloads = 0;
  let checks = 0;
  native.setFeedURL = (value) => { feed = value; };
  native.quitAndInstall = () => { quitCalls += 1; };
  native.checkForUpdates = () => {
    nativeCalled.resolve();
    if (!fetchZip) return;
    void (async () => {
      // The real proxy still requires its random per-attempt credentials.
      assert.equal((await readHttp(feed.url)).status, 401);
      const metadata = await readHttp(feed.url, feed.headers);
      assert.equal(metadata.status, 200);
      const zip = await readHttp(JSON.parse(metadata.body).url);
      assert.equal(zip.status, 200);
      assert.equal(zip.body.toString(), "fixture ZIP bytes");
      transferred.resolve();
    })().catch(transferred.reject);
  };
  const originalLoad = Module._load;
  Module._load = (name, ...args) => name === "electron" ? { autoUpdater: native } : originalLoad(name, ...args);
  let updater;
  try {
    const { MacUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
    updater = new MacUpdater(null, { version: "1.0.0", quit: () => assert.fail("unexpected app quit") });
  } finally {
    Module._load = originalLoad;
  }
  const warnings = [];
  updater.logger = { info() {}, warn(message) { warnings.push(message); }, error() {}, debug() {} };
  updater.autoInstallOnAppQuit = true;
  const workspace = mkdtempSync(join(tmpdir(), "omb-native-stage-"));
  const zip = join(workspace, "update.zip");
  writeFileSync(zip, "fixture ZIP bytes");
  t.after(async () => {
    if (updater.server?.listening) {
      await new Promise((resolve) => updater.server.close(resolve));
    }
    native.removeAllListeners();
    rmSync(workspace, { recursive: true, force: true });
  });
  updater.downloadUpdate = () => {
    downloads += 1;
    return updater.updateDownloaded(
      { info: { size: 17 }, url: new URL("https://fixture.invalid/update.zip") },
      { version: "2.0.0", downloadedFile: zip },
    );
  };
  updater.checkForUpdates = async () => { checks += 1; };
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(updater, (patch) => {
    state = { ...state, ...patch };
    states.push({ ...state });
  }, { nativeStaging: true });
  const timers = new Map();
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 120_000 && delay !== 300_000) return originalTimeout(callback, delay, ...args);
    const timer = { unref() {} };
    timers.set(delay, { callback, timer });
    return timer;
  });
  const originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    for (const [delay, pending] of timers) {
      if (pending.timer === timer) { timers.delete(delay); return; }
    }
    originalClear(timer);
  });
  return {
    native, updater, coordinator, states, timers, nativeCalled, transferred, warnings,
    state: () => state,
    calls: () => ({ downloads, checks, quitCalls }),
  };
}

test("real Mac ZIP transfer stays preparing until native ready; restart is single-flight", async (t) => {
  const h = harness(t);
  const download = h.coordinator.download();
  await h.transferred.promise;
  assert.equal(h.state().status, "preparing");
  assert.equal(h.updater.squirrelDownloadedUpdate, false);
  h.coordinator.install();
  await h.coordinator.download();
  await h.coordinator.check(true);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, quitCalls: 0 });
  const waitingListeners = h.native.listenerCount("update-downloaded");
  assert.throws(() => h.updater.quitAndInstall(), /not ready/);
  assert.equal(h.native.listenerCount("update-downloaded"), waitingListeners, "premature Restart never arms a future quit");

  h.native.emit("update-downloaded");
  await download;
  assert.equal(h.state().status, "downloaded");
  assert.equal(h.updater.squirrelDownloadedUpdate, true);
  assert.equal(h.native.listenerCount("update-downloaded"), 1, "temporary staging listener was removed");
  assert.equal(h.timers.has(300_000), false);
  h.coordinator.install();
  h.timers.get(120_000).callback();
  assert.equal(h.state().status, "installing");
  assert.match(h.state().message, /Quit and reopen/);
  assert.ok(h.warnings.some((message) => /restart handoff exceeded/.test(message)));
  h.coordinator.install();
  await h.coordinator.download();
  await h.coordinator.check(true);
  h.native.emit("update-downloaded");
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, quitCalls: 1 });
  t.diagnostic("ZIP transferred -> preparing (0 quits) -> native ready -> downloaded -> one restart; watchdog and late ready cannot repeat it");
});

test("a native staging deadline fails visibly without retrying or reviving on late readiness", async (t) => {
  const h = harness(t, { fetchZip: false });
  const download = h.coordinator.download();
  await h.nativeCalled.promise;
  assert.equal(h.state().status, "preparing");
  h.timers.get(300_000).callback();
  assert.equal(h.state().status, "error");
  assert.equal(h.state().retryable, false);
  assert.match(h.state().message, /took too long.*Quit and reopen/);
  assert.ok(h.warnings.some((message) => /preparation exceeded/.test(message)));
  const failed = h.state();
  await h.coordinator.download();
  await h.coordinator.check(true);
  h.coordinator.install();
  h.native.emit("update-downloaded");
  await download;
  h.updater.emit("download-progress", { percent: 100 });
  h.updater.emit("update-downloaded", { version: "9.0.0" });
  assert.deepEqual(h.state(), failed);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, quitCalls: 0 });
  assert.equal(h.native.listenerCount("update-downloaded"), 1);
  t.diagnostic("native never fetches ZIP -> deadline/error/retryable=false; late native ready keeps error and causes zero quits");
});

test("native validation errors after ZIP transfer remain visible and clean up staging listeners", async (t) => {
  const h = harness(t);
  const download = h.coordinator.download();
  await h.transferred.promise;
  h.native.emit("error", new Error("signature validation failed"));
  await download;
  assert.equal(h.state().status, "error");
  assert.equal(h.state().retryable, false);
  assert.match(h.state().message, /signature validation failed.*Quit and reopen/);
  assert.equal(h.states.filter((s) => s.status === "error").length, 1);
  assert.equal(h.native.listenerCount("error"), 1);
  assert.equal(h.native.listenerCount("update-downloaded"), 1);
  assert.equal(h.timers.has(300_000), false);
  const failed = h.state();
  await h.coordinator.download();
  await h.coordinator.check(true);
  h.coordinator.install();
  h.native.emit("update-downloaded");
  assert.deepEqual(h.state(), failed);
  assert.deepEqual(h.calls(), { downloads: 1, checks: 0, quitCalls: 0 });
});

test("a late native error after readiness is not silently routed as a background check", async (t) => {
  const h = harness(t);
  const download = h.coordinator.download();
  await h.transferred.promise;
  h.native.emit("update-downloaded");
  await download;
  h.native.emit("error", new Error("native stage lost"));
  assert.equal(h.state().status, "error");
  assert.equal(h.state().retryable, false);
  assert.match(h.state().message, /native stage lost/);
  h.coordinator.install();
  assert.equal(h.calls().quitCalls, 0);
});

test("Mac vendor patch fails closed on an unknown upstream shape", () => {
  assert.throws(() => patchMacUpdater("not the pinned MacUpdater"), /one Mac updater site to patch, found 0/);
});
