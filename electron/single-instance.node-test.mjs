import assert from "node:assert/strict";
import test from "node:test";

import { activateExistingWindow, releaseSingleInstanceLock } from "./single-instance.mjs";

function fakeWindow({ destroyed = false, minimized = false, focused = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isFocused: () => focused,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
}

test("shows and focuses the only living window", () => {
  const win = fakeWindow();
  assert.equal(activateExistingWindow([win]), true);
  assert.deepEqual(win.calls, ["show", "focus"]);
});

test("restores a minimized window before showing it", () => {
  const win = fakeWindow({ minimized: true });
  assert.equal(activateExistingWindow([win]), true);
  assert.deepEqual(win.calls, ["restore", "show", "focus"]);
});

test("skips destroyed windows without touching them", () => {
  const dead = fakeWindow({ destroyed: true });
  const alive = fakeWindow();
  assert.equal(activateExistingWindow([dead, alive]), true);
  assert.deepEqual(dead.calls, []);
  assert.deepEqual(alive.calls, ["show", "focus"]);
});

test("prefers the focused window among several", () => {
  const first = fakeWindow();
  const second = fakeWindow({ focused: true });
  assert.equal(activateExistingWindow([first, second]), true);
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, ["show", "focus"]);
});

test("reports failure when no window can be activated", () => {
  const dead = fakeWindow({ destroyed: true });
  assert.equal(activateExistingWindow([]), false);
  assert.equal(activateExistingWindow([dead]), false);
  assert.deepEqual(dead.calls, []);
});

function fakeApp({ holdsLock = true } = {}) {
  const calls = [];
  let held = holdsLock;
  return {
    calls,
    hasSingleInstanceLock: () => held,
    releaseSingleInstanceLock: () => {
      held = false;
      calls.push("releaseSingleInstanceLock");
    },
  };
}

test("releases a held single-instance lock for an update relaunch", () => {
  const app = fakeApp();
  assert.equal(releaseSingleInstanceLock(app), true);
  assert.deepEqual(app.calls, ["releaseSingleInstanceLock"]);
});

test("stays a no-op when the lock is not held", () => {
  const app = fakeApp({ holdsLock: false });
  assert.equal(releaseSingleInstanceLock(app), false);
  assert.deepEqual(app.calls, []);
});

test("releases the lock only once when the update signal fires twice", () => {
  const app = fakeApp();
  assert.equal(releaseSingleInstanceLock(app), true);
  assert.equal(releaseSingleInstanceLock(app), false);
  assert.deepEqual(app.calls, ["releaseSingleInstanceLock"]);
});
