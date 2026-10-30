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

test("synchronous check and download throws are handled", async () => {
  const h = harness();
  h.updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(h.coordinator.check(true));
  assert.deepEqual(h.getState(), { status: "error", message: "check threw" });

  h.updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(found(h, { manual: true }));
  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "download threw");
});

test("a download that throws at once is as quiet as one that fails later, unless only the person can fix it", async () => {
  const quiet = harness();
  quiet.updater.downloadUpdate = () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  await found(quiet);
  assert.equal(quiet.getState().status, "idle");
  assert.equal(errorStates(quiet.states).length, 0);

  const shown = harness();
  shown.updater.downloadUpdate = () => {
    throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
  };
  await found(shown);
  assert.equal(shown.getState().status, "error");
  assert.match(shown.getState().message, /Free some space/);
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
  // a real transfer stays silent until bytes arrive; the card must not wait
  updater.downloadUpdate = () => pending.promise;

  await found({ updater, coordinator });
  assert.deepEqual(getState(), { status: "downloading", version: "2.0.0", releaseNotes: undefined, percent: undefined, message: undefined });
  assert.equal(states.find((entry) => entry.status !== "checking").status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", version: "2.0.0", releaseNotes: undefined, percent: 12, message: undefined });

  pending.resolve();
  await settle();
});

test("downloaded waits for the updater download promise before becoming actionable", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  updater.downloadUpdate = () => pending.promise;

  await found({ updater, coordinator });
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.equal(getState().status, "downloading");

  pending.resolve(["update.zip"]);
  await settle();
  assert.equal(getState().status, "downloaded");
  assert.equal(getState().version, "2.0.0");
});

test("Mac transfer failures cannot overlap a pending download and remain retryable after it settles", async () => {
  const h = harness({ nativeStaging: true });
  const pending = deferred();
  let calls = 0;
  h.updater.downloadUpdate = () => { calls += 1; return pending.promise; };
  h.updater.quitAndInstall = () => assert.fail("an incomplete transfer cannot install");
  await found(h, { manual: true });
  h.updater.checkForUpdates = () => assert.fail("a check cannot overlap a Mac download");
  const failure = new Error("connection lost before ZIP completed");
  h.updater.emit("error", failure);
  assert.equal(h.getState().status, "error");
  assert.notEqual(h.getState().retryable, false);
  await h.coordinator.check(true);
  h.coordinator.install();
  assert.equal(calls, 1);
  pending.reject(failure);
  await settle();

  h.updater.downloadUpdate = async () => {
    calls += 1;
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return ["update.zip"];
  };
  await found(h, { manual: true });
  await settle();
  assert.equal(calls, 2);
  assert.equal(h.getState().status, "downloaded");
});

test("on a Mac, checking while an update downloads by itself makes its failure the person's to see", async () => {
  const h = harness({ nativeStaging: true });
  const transfer = deferred();
  h.updater.downloadUpdate = () => transfer.promise;

  await found(h);
  assert.equal(h.getState().status, "downloading");
  h.updater.checkForUpdates = () => assert.fail("a check cannot overlap a Mac download");
  await h.coordinator.check(true);
  transfer.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  await settle();

  assert.equal(h.getState().status, "error");
  assert.match(h.getState().message, /interrupted/);
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
  await downloadInto(h);
  h.updater.checkForUpdates = () => assert.fail("install still owns the updater");
  h.coordinator.install();
  watchdog();
  h.updater.downloadUpdate = () => assert.fail("a retry must not overlap a slow installer");
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
  const h = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  h.updater.downloadUpdate = () => {
    h.updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };
  await found(h);
  const downloading = { status: "downloading", version: "2.0.0", releaseNotes: undefined, percent: 42, message: undefined };
  assert.deepEqual(h.getState(), downloading);

  h.updater.checkForUpdates = () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.1.0" });
    h.updater.emit("update-not-available");
    return checkPending.promise;
  };
  const background = h.coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(h.getState(), downloading);

  downloadPending.resolve();
  await settle();
});

test("a download error remains authoritative after a later background failure", async () => {
  const h = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  h.updater.downloadUpdate = () => {
    h.updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };
  await found(h, { manual: true });
  h.updater.checkForUpdates = () => checkPending.promise;
  const background = h.coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await settle();
  const failed = { status: "error", version: "2.0.0", releaseNotes: undefined, percent: 75, message: "download failed first" };
  assert.deepEqual(h.getState(), failed);

  h.updater.emit("checking-for-update");
  h.updater.emit("update-available", { version: "2.1.0" });
  h.updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(h.getState(), failed);
});

test("a background failure stays silent before a later download failure only the person can fix", async () => {
  const h = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  h.updater.checkForUpdates = () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.1.0" });
    h.updater.emit("update-not-available");
    return checkPending.promise;
  };
  h.updater.downloadUpdate = () => {
    h.updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = h.coordinator.check();
  checkPending.reject(new Error("background check failed first"));
  await background;
  assert.deepEqual(h.getState(), { status: "downloading", version: "2.1.0", releaseNotes: undefined, percent: 18, message: undefined });
  assert.equal(errorStates(h.states).length, 0);

  downloadPending.reject(Object.assign(new Error("write failed"), { code: "ENOSPC" }));
  await settle();

  assert.equal(h.getState().status, "error");
  assert.match(h.getState().message, /Free some space/);
});

test("an update a check finds downloads without a click; only the restart waits for the person", async () => {
  for (const manual of [false, true]) {
    const found = harness();
    let downloads = 0;
    const transfer = deferred();
    found.updater.checkForUpdates = () => {
      found.updater.emit("checking-for-update");
      queueMicrotask(() => found.updater.emit("update-available", { version: "2.0.0" }));
      return Promise.resolve({ isUpdateAvailable: true });
    };
    found.updater.downloadUpdate = () => {
      downloads += 1;
      found.updater.emit("download-progress", { percent: 42.4 });
      return transfer.promise.then(() => {
        found.updater.emit("update-downloaded", { version: "2.0.0" });
        return ["update.zip"];
      });
    };
    found.updater.quitAndInstall = () => assert.fail("nothing restarts without the person's click");

    await found.coordinator.check(manual);
    assert.equal(downloads, 1, "the check itself started the download");
    assert.deepEqual(found.getState(), { status: "downloading", version: "2.0.0", releaseNotes: undefined, percent: 42, message: undefined });
    assert.equal(found.states.some((entry) => entry.status === "available"), false, "no state waits for a Download click");

    transfer.resolve();
    await settle();
    assert.deepEqual(found.getState(), { status: "downloaded", version: "2.0.0", releaseNotes: undefined, percent: 42, message: undefined });
  }

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("a download the hourly check started fails quietly, and the next check tries again", async () => {
  const h = harness();
  let downloads = 0;
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.0.0" });
  };
  let transfer;
  h.updater.downloadUpdate = () => {
    downloads += 1;
    transfer = deferred();
    return transfer.promise;
  };
  // electron-updater emits "error" for a broken transfer, then rejects the download.
  const breakTransfer = async () => {
    const error = new Error("ECONNRESET");
    h.updater.emit("error", error);
    transfer.reject(error);
    await settle();
  };

  await h.coordinator.check();
  assert.equal(h.getState().status, "downloading");
  await breakTransfer();
  assert.equal(h.getState().status, "idle");
  assert.equal(errorStates(h.states).length, 0, "nobody asked, so nothing failed in front of them");

  await h.coordinator.check();
  await breakTransfer();
  assert.equal(downloads, 2, "a quiet failure leaves the next check free to download again");

  await h.coordinator.check();
  transfer.reject(new Error("ETIMEDOUT"));
  await settle();
  assert.equal(downloads, 3);
  assert.equal(h.getState().status, "idle");
  assert.equal(errorStates(h.states).length, 0);
});

test("a failure only the person can fix is shown, and the hourly check stops downloading it again", async () => {
  for (const [failure, message] of [
    [Object.assign(new Error("sha512 checksum mismatch, expected abc"), { code: "ERR_UPDATER_CHECKSUM_MISMATCH" }), /failed verification/],
    [Object.assign(new Error("write failed"), { code: "ENOSPC" }), /Free some space/],
    [Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" }), /permissions/],
    [Object.assign(new Error("resource busy or locked"), { code: "EBUSY" }), /in use/],
  ]) {
    const h = harness();
    let downloads = 0;
    h.updater.downloadUpdate = () => {
      downloads += 1;
      h.updater.emit("error", failure);
      return Promise.reject(failure);
    };

    await found(h);
    await settle();
    assert.equal(h.getState().status, "error", failure.code);
    assert.match(h.getState().message, message);

    await found(h);
    await settle();
    assert.equal(downloads, 1, `${failure.code}: no second download until the person tries again`);
    assert.equal(h.getState().status, "error");

    await found(h, { manual: true });
    await settle();
    assert.equal(downloads, 2);
  }
});

test("checking while an update downloads by itself makes its failure the person's to see", async () => {
  const h = harness();
  const transfer = deferred();
  h.updater.checkForUpdates = async () => {
    h.updater.emit("update-available", { version: "2.0.0" });
  };
  h.updater.downloadUpdate = () => transfer.promise;

  await h.coordinator.check();
  assert.equal(h.getState().status, "downloading");
  await h.coordinator.check(true);
  transfer.reject(new Error("download failed"));
  await settle();

  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "download failed");
});

test("a download that the person's own check started reports its failure", async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => {
    h.updater.emit("update-available", { version: "2.0.0" });
  };
  h.updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await h.coordinator.check(true);
  await settle();

  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "download failed");
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

  await found(download, { manual: true });
  await settle();
  assert.equal(errorStates(download.states).length, 1);
  assert.equal(download.getState().status, "error");
  assert.equal(download.getState().message, "download failed once");
});

test("the hand-off install opens the staged package instead of quitting", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
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
  assert.ok(h.states.some((entry) => entry.status === "installing"));
  assert.equal(h.getState().command, "sudo apt-get install -y '/tmp/x.deb'");
  assert.equal(h.getState().terminalOpened, true);
});

test("a failed hand-off is reported instead of leaving the card spinning", async () => {
  const h = harness({ handOffInstall: () => Promise.reject(new Error("no handler for .deb")) });

  await downloadInto(h);
  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

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

test("a staged update survives hourly checks that find nothing newer, and a manual check still replaces it", async () => {
  const h = harness();
  await downloadInto(h);
  let checks = 0;
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.0.0" });
  };
  const staged = h.getState();

  await h.coordinator.check();
  assert.equal(checks, 1);
  assert.deepEqual(h.getState(), staged);
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-not-available", {});
  };
  await h.coordinator.check();
  assert.deepEqual(h.getState(), staged);
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("update-available", { version: "2.1.0" });
  };
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "2.1.0" });
    return ["/tmp/OpenMausBot-2.1.0-amd64.deb"];
  };
  await h.coordinator.check(true);
  await settle();
  assert.equal(h.getState().version, "2.1.0");
});

test("a superseded check error event cannot invalidate a completed download", async () => {
  const h = harness();
  const pending = deferred();
  h.updater.checkForUpdates = () => {
    h.updater.emit("update-available", { version: "2.0.0" });
    return pending.promise;
  };
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return ["update.zip"];
  };
  const check = h.coordinator.check();
  await settle();
  assert.equal(h.getState().status, "downloaded");

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
  await downloadInto(h);
  h.updater.checkForUpdates = () => assert.fail("installation owns the updater");
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
      await found(h, { manual: true });
      await settle();
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
    h.updater.downloadUpdate = async () => {
      h.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["/tmp/OpenMausBot-2.0.0-amd64.deb"];
    };
    await h.coordinator.check(true);
    await settle();
    assert.equal(checks, 1);
    assert.equal(h.getState().status, "downloaded");
  }
});

test("carries the release notes with the version, as one capped string", async () => {
  const { releaseNotesText } = await import("./updater-coordinator.mjs");
  assert.equal(releaseNotesText("<ul><li>One</li></ul>"), "<ul><li>One</li></ul>");
  assert.equal(releaseNotesText([{ version: "2", note: "Two" }, { version: "1", note: "One" }]), "Two\nOne");
  assert.equal(releaseNotesText("   "), undefined);
  assert.equal(releaseNotesText(null), undefined);
  assert.equal(releaseNotesText("x".repeat(9000)).length, 8000);

  const h = harness();
  h.updater.downloadUpdate = () => new Promise(() => {});
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.0.0", releaseNotes: "- **Faster start.** Opens at once." });
  };
  await h.coordinator.check();
  await settle();
  assert.equal(h.getState().status, "downloading");
  assert.equal(h.getState().version, "2.0.0");
  assert.equal(h.getState().releaseNotes, "- **Faster start.** Opens at once.");
});

// ---- Ubuntu .deb: install behind a password prompt, then reopen ----------

const SUM = "c2hhNTEy";
function elevatedHarness(elevatedInstall, extra = {}) {
  const calls = { elevated: [], handOff: [], relaunch: 0 };
  const h = harness({
    elevatedInstall: (files, info) => {
      calls.elevated.push({ files, info });
      return elevatedInstall(files, info);
    },
    relaunch: () => {
      calls.relaunch += 1;
    },
    handOffInstall: (files) => {
      calls.handOff.push(files);
      return Promise.resolve({ command: "sudo apt-get install -y '/tmp/x.deb'", terminalOpened: true });
    },
    ...extra,
  });
  h.updater.quitAndInstall = () => assert.fail("a system package must not be installed by quitAndInstall");
  h.updater.downloadedUpdateHelper = { downloadedFileInfo: { sha512: SUM } };
  return { h, calls };
}

test("elevated install: one click installs the staged package and reopens", async () => {
  const { h, calls } = elevatedHarness(() => Promise.resolve({ ok: true }));
  await downloadInto(h);

  h.coordinator.install();
  // the person sees the prompt coming before it appears
  assert.equal(h.getState().status, "installing");
  assert.match(h.getState().message, /password/i);
  await settle();

  assert.deepEqual(calls.elevated, [{ files: ["/tmp/OpenMausBot-2.0.0-amd64.deb"], info: { sha512: SUM } }]);
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.handOff, [], "no terminal when the install worked");
  // the card stays busy while the app reopens: no second click, no stray state
  assert.equal(h.getState().status, "installing");
  assert.equal(h.getState().message, undefined);
  h.coordinator.install();
  await settle();
  assert.equal(calls.elevated.length, 1);
  assert.equal(calls.relaunch, 1);
});

test("elevated install: closing the password prompt leaves the update ready to retry", async () => {
  let answer = { ok: false, reason: "declined", detail: "The password prompt was closed." };
  const { h, calls } = elevatedHarness(() => Promise.resolve(answer));
  await downloadInto(h);

  h.coordinator.install();
  await settle();

  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.0.0");
  assert.equal(calls.relaunch, 0);
  assert.deepEqual(calls.handOff, []);

  // asking again works, and succeeds this time
  answer = { ok: true };
  h.coordinator.install();
  await settle();
  assert.equal(calls.elevated.length, 2);
  assert.equal(calls.relaunch, 1);
});

test("elevated install: a package that fails its checksum is never handed to a terminal", async () => {
  const { h, calls } = elevatedHarness(() =>
    Promise.resolve({ ok: false, reason: "checksum", detail: "The downloaded update did not match its checksum." }),
  );
  await downloadInto(h);

  h.coordinator.install();
  await settle();

  assert.equal(h.getState().status, "error");
  // the repo's one integrity message (update-errors.mjs), not a new wording
  assert.match(h.getState().message, /failed verification/);
  assert.deepEqual(calls.handOff, [], "the command would install the same bad file");
  assert.equal(calls.relaunch, 0);
});

for (const reason of ["refused", "unavailable", "failed", "unverifiable"]) {
  test(`elevated install: ${reason} falls back to the terminal hand-off and says why`, async () => {
    const { h, calls } = elevatedHarness(() => Promise.resolve({ ok: false, reason, detail: `because ${reason}.` }));
    await downloadInto(h);

    h.coordinator.install();
    await settle();

    assert.equal(h.getState().status, "handed-off");
    assert.equal(h.getState().command, "sudo apt-get install -y '/tmp/x.deb'");
    assert.equal(h.getState().message, `because ${reason}.`);
    assert.deepEqual(calls.handOff, [["/tmp/OpenMausBot-2.0.0-amd64.deb"]]);
    assert.equal(calls.relaunch, 0);
  });
}

test("elevated install: with no hand-off to fall back to, a failure is an error", async () => {
  const { h } = elevatedHarness(() => Promise.resolve({ ok: false, reason: "failed", detail: "The install did not finish: E: lock." }), {
    handOffInstall: null,
  });
  await downloadInto(h);

  h.coordinator.install();
  await settle();

  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "The install did not finish: E: lock.");
});

test("elevated install: a thrown error or a failed relaunch is reported, not left spinning", async () => {
  const thrown = elevatedHarness(() => Promise.reject(new Error("polkit exploded")));
  await downloadInto(thrown.h);
  thrown.h.coordinator.install();
  await settle();
  assert.equal(thrown.h.getState().status, "error");
  assert.equal(thrown.h.getState().message, "polkit exploded");

  const relaunch = elevatedHarness(() => Promise.resolve({ ok: true }), {
    relaunch: () => {
      throw new Error("cannot relaunch");
    },
  });
  await downloadInto(relaunch.h);
  relaunch.h.coordinator.install();
  await settle();
  assert.equal(relaunch.h.getState().status, "error");
  assert.equal(relaunch.h.getState().message, "cannot relaunch");
});

test("repeated silent check failures surface a retryable notice instead of staying idle forever", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com"));

  await coordinator.check();
  await coordinator.check();
  assert.equal(getState().status, "idle");
  await coordinator.check();

  assert.equal(getState().status, "error");
  assert.match(getState().message, /Couldn't check for updates/);
  assert.notEqual(getState().retryable, false);
});

test("a successful check resets the silent failure count", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  await coordinator.check();
  await coordinator.check();
  updater.checkForUpdates = async () => updater.emit("update-not-available");
  await coordinator.check();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  await coordinator.check();
  await coordinator.check();

  assert.equal(getState().status, "idle");
});

test("a manual retry after the notice clears it and checks again", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  for (let i = 0; i < 3; i++) await coordinator.check();
  assert.equal(getState().status, "error");

  updater.checkForUpdates = async () => updater.emit("update-not-available");
  await coordinator.check(true);

  assert.equal(getState().status, "idle");
});

test("after the notice, the hourly check keeps going: reaching the feed clears it, and a release found is downloaded", async () => {
  const h = harness();
  h.updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  for (let i = 0; i < 3; i++) await h.coordinator.check();
  assert.equal(h.getState().status, "error");

  // a quiet hourly check that reaches the feed clears the notice by itself
  let checks = 0;
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-not-available");
  };
  await h.coordinator.check();
  assert.equal(checks, 1);
  assert.equal(h.getState().status, "idle");

  // and once the notice is back, a release found by an hourly check still downloads
  h.updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  for (let i = 0; i < 3; i++) await h.coordinator.check();
  assert.equal(h.getState().status, "error");
  await downloadInto(h);
  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.0.0");
});

test("the check-failure notice never covers a staged update: hourly re-checks that fail stay silent", async () => {
  const h = harness();
  await downloadInto(h);
  const staged = h.getState();
  h.updater.checkForUpdates = () => {
    h.updater.emit("error", new Error("offline"));
    return Promise.reject(new Error("offline"));
  };
  for (let i = 0; i < 4; i++) await h.coordinator.check();
  assert.deepEqual(h.getState(), staged);
});
