import assert from "node:assert/strict";
import test from "node:test";

import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";

function harness({ platform = "linux", windows = [] } = {}) {
  const listeners = new Map();
  const app = {
    on: (event, fn) => listeners.set(event, fn),
    quit: () => app.quitCalls.push(1),
    quitCalls: [],
  };
  const quit = createAllWindowsClosedQuit({ app, platform, allWindows: () => windows });
  return { app, quit, windows, emit: (event) => listeners.get(event)?.() };
}

test("an empty window set during startup does not quit", () => {
  const { app, emit } = harness();
  emit("window-all-closed");
  assert.equal(app.quitCalls.length, 0);
});

test("a drain that fired during startup still quits once startup settles", () => {
  const { app, quit, emit } = harness();
  // The splash fallback destroyed the only window mid-boot (issue #2028):
  // the event already ran and was gated, and it will not fire again.
  emit("window-all-closed");
  quit.settleStartup();
  assert.equal(app.quitCalls.length, 1);
});

test("startup that settles with a live window stays up, then quits on the last close", () => {
  const windows = [{}];
  const { app, quit, emit } = harness({ windows });
  quit.settleStartup();
  assert.equal(app.quitCalls.length, 0);
  windows.length = 0;
  emit("window-all-closed");
  assert.equal(app.quitCalls.length, 1);
});

test("macOS never quits on the window drain, before or after startup", () => {
  const { app, quit, emit } = harness({ platform: "darwin" });
  emit("window-all-closed");
  quit.settleStartup();
  emit("window-all-closed");
  assert.equal(app.quitCalls.length, 0);
});

test("a boot drained mid-startup recovers into the main window instead of exiting (#2028)", () => {
  const windows = [];
  const { app, quit, emit } = harness({ windows });
  // The splash fallback destroyed the only window; boot is still running.
  emit("window-all-closed");
  assert.equal(app.quitCalls.length, 0);
  // Boot went on to create the main window, so settling keeps the app up.
  windows.push({});
  quit.settleStartup();
  assert.equal(app.quitCalls.length, 0);
  windows.length = 0;
  emit("window-all-closed");
  assert.equal(app.quitCalls.length, 1);
});
