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

// Drives a successful download so install() has staged paths to hand off.
async function downloadInto(h, files = ["/tmp/OpenMausBot-2.0.0-amd64.deb"]) {
  h.updater.downloadUpdate = () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return Promise.resolve(files);
  };
  await h.coordinator.download();
}

function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

test("automatic check rejection is handled and returns to idle", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));

  await assert.doesNotReject(coordinator.check());

  assert.equal(getState().status, "idle");
});

test("manual check rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("feed failed"));

  await assert.doesNotReject(coordinator.check(true));

  assert.deepEqual(getState(), { status: "error", message: "feed failed" });
});

test("download rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await assert.doesNotReject(coordinator.download());

  assert.deepEqual(getState(), { status: "error", message: "download failed" });
});

test("synchronous check and download throws are handled", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(coordinator.check(true));
  assert.deepEqual(getState(), { status: "error", message: "check threw" });

  updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(coordinator.download());
  assert.deepEqual(getState(), { status: "error", message: "download threw" });
});

test("a concurrent background check cannot downgrade a manual check", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const manual = coordinator.check(true);
  const background = coordinator.check();
  assert.strictEqual(background, manual);
  assert.equal(calls, 1);

  pending.reject(new Error("manual failure"));
  await manual;

  assert.deepEqual(getState(), { status: "error", message: "manual failure" });
});

test("a manual request during a background check preserves user-visible errors", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const background = coordinator.check();
  const manual = coordinator.check(true);
  assert.strictEqual(manual, background);
  assert.equal(calls, 1);

  pending.reject(new Error("background request failed"));
  await background;

  assert.deepEqual(getState(), { status: "error", message: "background request failed" });
});

test("download reports downloading before the first progress event", async () => {
  const { updater, coordinator, getState, states } = harness();
  const pending = deferred();
  // a real transfer stays silent until bytes arrive; the button must not wait
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading" });
  assert.equal(states[0].status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", percent: 12 });

  pending.resolve();
  await download;
});

test("downloaded waits for the updater download promise before becoming actionable", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.deepEqual(getState(), { status: "downloading" });

  pending.resolve(["update.zip"]);
  await download;
  assert.deepEqual(getState(), { status: "downloaded", version: "2.0.0" });
});

test("Mac transfer failures cannot overlap a pending download and remain retryable after it settles", async () => {
  const h = harness({ nativeStaging: true });
  const pending = deferred();
  let calls = 0;
  h.updater.downloadUpdate = () => { calls += 1; return pending.promise; };
  h.updater.checkForUpdates = () => assert.fail("a check cannot overlap a Mac download");
  h.updater.quitAndInstall = () => assert.fail("an incomplete transfer cannot install");
  const first = h.coordinator.download();
  const failure = new Error("connection lost before ZIP completed");
  h.updater.emit("error", failure);
  assert.equal(h.getState().status, "error");
  assert.notEqual(h.getState().retryable, false);
  assert.strictEqual(h.coordinator.download(), first);
  await h.coordinator.check(true);
  h.coordinator.install();
  assert.equal(calls, 1);
  pending.reject(failure);
  await first;

  h.updater.downloadUpdate = async () => {
    calls += 1;
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return ["update.zip"];
  };
  await h.coordinator.download();
  assert.equal(calls, 2);
  assert.equal(h.getState().status, "downloaded");
});

test("a restart watchdog keeps Windows/AppImage installs locked against overlapping retries", async (t) => {
  const h = harness();
  let quits = 0;
  let watchdog;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 120_000);
    watchdog = callback;
    return { unref() {} };
  });
  h.updater.quitAndInstall = () => { quits += 1; };
  h.updater.checkForUpdates = () => assert.fail("install still owns the updater");
  await downloadInto(h);
  h.coordinator.install();
  watchdog();
  h.updater.downloadUpdate = () => assert.fail("a retry must not overlap a slow installer");
  await h.coordinator.download();
  await h.coordinator.check(true);
  h.coordinator.install();
  assert.equal(h.getState().status, "installing");
  assert.match(h.getState().message, /Quit and reopen/);
  assert.equal(quits, 1);
});

test("an asynchronous native install error escapes the restarting spinner", () => {
  const { updater, coordinator, getState, states } = harness();
  const error = new Error("native staging failed");
  updater.quitAndInstall = () => updater.emit("error", error);

  coordinator.install();

  assert.deepEqual(getState(), { status: "error", message: "native staging failed" });
  assert.equal(errorStates(states).length, 1);
});

test("a synchronous install failure becomes a user-visible error", () => {
  const { updater, coordinator, getState } = harness();
  updater.quitAndInstall = () => {
    throw new Error("install threw");
  };

  coordinator.install();

  assert.deepEqual(getState(), { status: "error", message: "install threw" });
});

test("an active download state survives a later background check failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("update-not-available");
    return checkPending.promise;
  };

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  const background = coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  downloadPending.resolve();
  await download;
});

test("a download error remains authoritative after a later background failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => checkPending.promise;

  const download = coordinator.download();
  const background = coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await download;
  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });
});

test("a background failure stays silent before a later download failure", async () => {
  const { updater, coordinator, getState, states } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.checkForUpdates = () => checkPending.promise;
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = coordinator.check();
  const download = coordinator.download();

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed first"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 18 });
  assert.equal(errorStates(states).length, 0);

  const downloadError = new Error("download failed later");
  downloadPending.reject(downloadError);
  await download;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 18,
    message: "download failed later",
  });
});

test("available, not-available, progress, and downloaded events preserve success behavior", async () => {
  const available = harness();
  available.updater.checkForUpdates = () => {
    available.updater.emit("checking-for-update");
    queueMicrotask(() => available.updater.emit("update-available", { version: "2.0.0" }));
    return Promise.resolve({ isUpdateAvailable: true });
  };
  await available.coordinator.check(true);
  assert.equal(available.getState().status, "available");
  assert.equal(available.getState().version, "2.0.0");

  available.updater.downloadUpdate = () => {
    available.updater.emit("download-progress", { percent: 42.4 });
    return Promise.resolve().then(() => {
      available.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    });
  };
  await available.coordinator.download();
  assert.deepEqual(available.getState(), {
    status: "downloaded",
    version: "2.0.0",
    message: undefined,
    percent: 42,
  });

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("an updater error event and rejected promise produce one deterministic state", async () => {
  const check = harness();
  const checkError = new Error("check failed once");
  check.updater.checkForUpdates = () =>
    Promise.reject(checkError).catch((error) => {
      check.updater.emit("error", error);
      throw error;
    });

  await check.coordinator.check(true);
  assert.equal(errorStates(check.states).length, 1);
  assert.deepEqual(check.getState(), { status: "error", message: "check failed once" });

  const download = harness();
  const downloadError = new Error("download failed once");
  download.updater.downloadUpdate = () =>
    Promise.reject(downloadError).catch((error) => {
      download.updater.emit("error", error);
      throw error;
    });

  await download.coordinator.download();
  assert.equal(errorStates(download.states).length, 1);
  assert.deepEqual(download.getState(), { status: "error", message: "download failed once" });
});

test("the hand-off install opens the staged package instead of quitting", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      // what the user still has to do travels back with the state
      return Promise.resolve({ command: "sudo apt-get install -y '/tmp/x.deb'", terminalOpened: true });
    },
  });
  h.updater.quitAndInstall = () => assert.fail("a system package must not be installed by quitAndInstall");

  await downloadInto(h);
  assert.equal(h.getState().status, "downloaded");

  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, [["/tmp/OpenMausBot-2.0.0-amd64.deb"]]);
  assert.equal(h.getState().status, "handed-off");
  // the user watched something happen between the click and the result
  assert.ok(h.states.some((entry) => entry.status === "installing"));
  assert.equal(h.getState().command, "sudo apt-get install -y '/tmp/x.deb'");
  assert.equal(h.getState().terminalOpened, true);
});

test("a failed hand-off is reported instead of leaving the card spinning", async () => {
  const h = harness({ handOffInstall: () => Promise.reject(new Error("no handler for .deb")) });

  await downloadInto(h);
  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  // version survives the merge from the download — assert what the card reads
  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "no handler for .deb");
});

test("the hand-off sees no staged file when nothing downloaded", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      return Promise.resolve();
    },
  });

  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, [null]);
});

test("without a hand-off the install still quits and installs", async () => {
  const h = harness();
  let called = 0;
  h.updater.quitAndInstall = () => {
    called += 1;
  };

  await downloadInto(h, ["/tmp/OpenMausBot-2.0.0.AppImage"]);
  h.coordinator.install();

  assert.equal(called, 1);
  assert.equal(h.getState().status, "installing");
});

test("a staged update survives hourly checks until the user explicitly checks again", async () => {
  const h = harness();
  let checks = 0;
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.1.0" });
  };
  await downloadInto(h);
  const staged = h.getState();

  await h.coordinator.check();
  assert.equal(checks, 0);
  assert.deepEqual(h.getState(), staged);

  await h.coordinator.check(true);
  assert.equal(checks, 1);
  assert.equal(h.getState().status, "available");
  assert.equal(h.getState().version, "2.1.0");
});

test("a superseded check error event cannot invalidate a completed download", async () => {
  const h = harness();
  const pending = deferred();
  h.updater.checkForUpdates = () => pending.promise;
  const check = h.coordinator.check();
  await downloadInto(h);

  const error = new Error("the earlier feed request failed");
  h.updater.emit("error", error);
  pending.reject(error);
  await check;

  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.0.0");
});

test("checks cannot replace an install in progress or its completed hand-off", async () => {
  const pending = deferred();
  const h = harness({ handOffInstall: () => pending.promise });
  h.updater.checkForUpdates = () => assert.fail("installation owns the updater");
  await downloadInto(h);
  h.coordinator.install();

  await h.coordinator.check();
  await h.coordinator.check(true);
  assert.equal(h.getState().status, "installing");

  pending.resolve({ command: "install the staged package", terminalOpened: false });
  await new Promise((resolve) => setImmediate(resolve));
  const handedOff = h.getState();
  await h.coordinator.check();
  assert.equal(h.getState().status, "handed-off");
  assert.deepEqual(h.getState(), handedOff);
});

test("failed download and hand-off actions survive automatic checks but remain retryable", async () => {
  for (const failure of ["download", "hand-off"]) {
    const h = harness({ handOffInstall: () => Promise.reject(new Error("hand-off failed")) });
    if (failure === "download") {
      h.updater.downloadUpdate = () => Promise.reject(new Error("download failed"));
      await h.coordinator.download();
    } else {
      await downloadInto(h);
      h.coordinator.install();
      await new Promise((resolve) => setImmediate(resolve));
    }
    let checks = 0;
    h.updater.checkForUpdates = async () => {
      checks += 1;
      h.updater.emit("checking-for-update");
      h.updater.emit("update-available", { version: "2.0.0" });
    };
    const failed = h.getState();
    assert.equal(failed.status, "error");
    await h.coordinator.check();
    assert.equal(checks, 0);
    assert.deepEqual(h.getState(), failed);
    await h.coordinator.check(true);
    assert.equal(checks, 1);
    assert.equal(h.getState().status, "available");
  }
});
