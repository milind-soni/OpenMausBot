import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options) {
  const updater = new EventEmitter();
  // electron-updater has its own error listener; model that without routing it.
  updater.on("error", () => {});
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(
    updater,
    (patch) => {
      state = { ...state, ...patch };
      states.push({ ...state });
    },
    options,
  );
  return { updater, coordinator, states, getState: () => state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function found(h, { manual = false, version = "2.0.0" } = {}) {
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version });
  };
  await h.coordinator.check(manual);
}

async function downloadInto(h, files = ["/tmp/OpenMausBot-2.0.0-amd64.deb"]) {
  h.updater.downloadUpdate = () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return Promise.resolve(files);
  };
  await found(h);
  await settle();
}

function newerFeed(h, version = "2.1.0") {
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version });
  };
}

test("a staged update is replaced quietly when the feed offers a newer one", async () => {
  const h = harness({ handOffInstall: async (files) => ({ command: `install ${files[0]}` }) });
  await downloadInto(h);
  newerFeed(h);
  let downloads = 0;
  h.updater.downloadUpdate = async () => {
    downloads += 1;
    h.updater.emit("update-downloaded", { version: "2.1.0" });
    return ["/tmp/OpenMausBot-2.1.0-amd64.deb"];
  };
  await h.coordinator.check();
  await settle();
  assert.equal(downloads, 1);
  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.1.0");
  h.coordinator.install();
  await settle();
  assert.equal(h.getState().command, "install /tmp/OpenMausBot-2.1.0-amd64.deb");
});

test("a handed-off update shows the newer file's command after it is replaced", async () => {
  const h = harness({ handOffInstall: async (files) => ({ command: `install ${files[0]}` }) });
  await downloadInto(h);
  h.coordinator.install();
  await settle();
  assert.equal(h.getState().status, "handed-off");
  assert.match(h.getState().command, /2\.0\.0/);
  newerFeed(h);
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "2.1.0" });
    return ["/tmp/OpenMausBot-2.1.0-amd64.deb"];
  };
  await h.coordinator.check();
  await settle();
  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.1.0");
  h.coordinator.install();
  await settle();
  assert.equal(h.getState().status, "handed-off");
  assert.equal(h.getState().command, "install /tmp/OpenMausBot-2.1.0-amd64.deb");
});

test("an older or equal feed version never replaces the staged update", async () => {
  for (const version of ["2.0.0", "1.9.9", "2.0.0-beta.1", undefined]) {
    const h = harness();
    await downloadInto(h);
    h.updater.checkForUpdates = async () => {
      h.updater.emit("checking-for-update");
      h.updater.emit("update-available", { version });
    };
    h.updater.downloadUpdate = () => assert.fail("nothing newer to download");
    const staged = h.getState();
    await h.coordinator.check();
    await settle();
    assert.deepEqual(h.getState(), staged);
  }
});

test("a quiet check failing leaves the staged update as it was", async () => {
  for (const needsPerson of [false, true]) {
    const h = harness();
    await downloadInto(h);
    const staged = h.getState();
    h.updater.checkForUpdates = () => Promise.reject(new Error(needsPerson ? "no space left on device" : "offline"));
    await h.coordinator.check();
    assert.deepEqual(h.getState(), staged);
    // the staged update is still installable
    h.updater.quitAndInstall = () => {};
    h.coordinator.install();
    assert.equal(h.getState().status, "installing");
  }
});

// electron-updater empties its pending cache before it downloads a newer file, so the staged one is gone by then.
test("a failed replacement download drops the staged update, and a later check downloads the newest again", async () => {
  for (const needsPerson of [false, true]) {
    const h = harness();
    await downloadInto(h);
    newerFeed(h);
    h.updater.downloadUpdate = async () => {
      h.updater.emit("download-progress", { percent: 40 });
      throw new Error(needsPerson ? "no space left on device" : "connection reset");
    };
    await h.coordinator.check();
    await settle();
    // no "ready" card for a file that no longer exists
    assert.equal(h.getState().status, needsPerson ? "error" : "idle");
    if (needsPerson) assert.match(h.getState().message, /disk space/);

    h.updater.downloadUpdate = async () => {
      h.updater.emit("update-downloaded", { version: "2.1.0" });
      return ["/tmp/OpenMausBot-2.1.0-amd64.deb"];
    };
    // quietly on the next hourly check; after a shown error, from the card's Retry
    await h.coordinator.check(needsPerson);
    await settle();
    assert.equal(h.getState().status, "downloaded");
    assert.equal(h.getState().version, "2.1.0");
  }
});

test("an error the person has not acknowledged, an install, and recovery are never superseded", async () => {
  const feed = (h) => {
    newerFeed(h);
    h.updater.checkForUpdates = () => assert.fail("the action owns the updater");
    h.updater.downloadUpdate = () => assert.fail("the action owns the updater");
  };
  // failed hand-off
  let h = harness({ handOffInstall: () => Promise.reject(new Error("hand-off failed")) });
  await downloadInto(h);
  h.coordinator.install();
  await settle();
  let before = h.getState();
  assert.equal(before.status, "error");
  feed(h);
  await h.coordinator.check();
  assert.deepEqual(h.getState(), before);
  // install in flight (elevated prompt open)
  const pending = deferred();
  h = harness({ elevatedInstall: () => pending.promise });
  await downloadInto(h);
  h.coordinator.install();
  before = h.getState();
  feed(h);
  await h.coordinator.check();
  assert.deepEqual(h.getState(), before);
  // native staging
  h = harness({ nativeStaging: true });
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return [];
  };
  await found(h);
  await settle();
  before = h.getState();
  feed(h);
  await h.coordinator.check();
  assert.deepEqual(h.getState(), before);
});

test("an in-flight check cannot replace an update whose install began meanwhile", async () => {
  const pendingCheck = deferred();
  const pendingInstall = deferred();
  const h = harness({ elevatedInstall: () => pendingInstall.promise });
  await downloadInto(h);
  h.updater.checkForUpdates = () => pendingCheck.promise;
  const check = h.coordinator.check();
  h.coordinator.install();
  h.updater.downloadUpdate = () => assert.fail("installing");
  h.updater.emit("update-available", { version: "2.1.0" });
  pendingCheck.resolve();
  await check;
  assert.equal(h.getState().status, "installing");
});

test("a declined password prompt keeps the update replaceable", async () => {
  const h = harness({ elevatedInstall: async () => ({ ok: false, reason: "declined", detail: "closed" }) });
  await downloadInto(h);
  h.coordinator.install();
  await settle();
  assert.equal(h.getState().status, "downloaded");
  newerFeed(h);
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "2.1.0" });
    return ["/tmp/OpenMausBot-2.1.0-amd64.deb"];
  };
  await h.coordinator.check();
  await settle();
  assert.equal(h.getState().version, "2.1.0");
});
