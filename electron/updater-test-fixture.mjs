import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function harness(options) {
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

export const settle = () => new Promise((resolve) => setImmediate(resolve));

export async function found(h, { manual = false, version = "2.0.0" } = {}) {
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version });
  };
  await h.coordinator.check(manual);
}

export async function downloadInto(h, files = ["/tmp/OpenMausBot-2.0.0-amd64.deb"]) {
  h.updater.downloadUpdate = () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return Promise.resolve(files);
  };
  await found(h);
  await settle();
}

export function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

export const SUM = "c2hhNTEy";
export function elevatedHarness(elevatedInstall, extra = {}) {
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

