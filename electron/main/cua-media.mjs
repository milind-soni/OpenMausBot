// Extracted from electron/main.mjs: the CUA/display-media subsystem,
// verbatim — the cuaReady connection promise, the android device controller,
// the display-media guard and its request counter, the display-media
// response helper, and the screen:preview-intent IPC registration (a feature
// registration, not an app lifecycle hook — the company-backup.mjs
// precedent; the registrations run at import time, which is before app
// ready, exactly as before). This module owns the cuaReady and
// displayMediaRequestCount live bindings; main.mjs imports them read-only
// and reassigns them only through the exported setters at the exact former
// assignment points — the server-runtime.mjs accessor pattern.

import { ipcMain } from "electron";
import { createRequire } from "node:module";
import { createAndroidDeviceController } from "../android-device.mjs";
import localOriginModule from "../local-origin.cjs";

const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback } = require("../screen-preview.cjs");

const { localOnlySync } = localOriginModule;

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

export function getCuaReady() {
  return cuaReady;
}

export function setCuaReady(next) {
  cuaReady = next;
}

export function bumpDisplayMediaRequestCount() {
  displayMediaRequestCount += 1;
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  // An empty response intentionally rejects the renderer request, and Electron
  // can surface that rejection by throwing from the callback. A selected
  // source should never fail delivery, so keep that path visible in logs.
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

ipcMain.on("screen:preview-intent", localOnlySync("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
}));

export {
  androidDevice,
  cuaReady,
  displayMediaGuard,
  displayMediaRequestCount,
  respondToDisplayMediaRequest,
};
