import assert from "node:assert/strict";
import test from "node:test";

import { createDialogGate, DIALOG_HOLDS, underDialogKind } from "./browser-pane-under-dialog.mjs";

const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error: error.message }));

function gate() {
  const applied = [];
  const timers = [];
  const g = createDialogGate({ apply: async (method, params) => { applied.push([method, params]); }, setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => {} });
  return { g, applied, timers };
}

test("names every kind the pane forwards", () => {
  for (const [method, kind] of [
    ["Page.handleJavaScriptDialog", "browser"], ["Page.navigate", "browser"], ["Page.getNavigationHistory", "browser"], ["Fetch.continueRequest", "browser"], ["Target.attachToTarget", "browser"],
    ["Page.startScreencast", "screencast"], ["Page.stopScreencast", "screencast"], ["Page.screencastFrameAck", "screencast"],
    ["Input.dispatchMouseEvent", "input"], ["Runtime.callFunctionOn", "page"], ["DOM.getContentQuads", "page"], ["Accessibility.getFullAXTree", "page"], ["Page.getLayoutMetrics", "page"], ["Page.captureScreenshot", "page"],
    ["Page.createIsolatedWorld", "other"], ["Network.enable", "other"], ["DOM.enable", "other"],
  ]) assert.equal(underDialogKind(method), kind, method);
});

test("settles what was under way when a dialog opens: input as delivered, the screencast at once, a read with the dialog's error, the rest after a grace", async () => {
  const { g, timers } = gate();
  const click = outcome(g.run("Input.dispatchMouseEvent", {}, never));
  const cast = outcome(g.run("Page.stopScreencast", {}, never));
  const read = outcome(g.run("Runtime.callFunctionOn", {}, never));
  const world = outcome(g.run("Page.createIsolatedWorld", {}, never));
  const history = g.run("Page.getNavigationHistory", {}, async () => ({ entries: [] }));
  g.opened();
  assert.deepEqual(await click, { value: {} });
  assert.deepEqual(await cast, { value: {} });
  assert.deepEqual(await read, { error: DIALOG_HOLDS });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1_000);
  timers[0].run();
  assert.deepEqual(await world, { error: DIALOG_HOLDS });
  assert.deepEqual(await history, { entries: [] });
});

test("while a dialog is open: reads and input refused at once, the screencast's wanted state kept and applied once it closes", async () => {
  const { g, applied } = gate();
  g.opened();
  const sent = [];
  const send = (method) => () => { sent.push(method); return never(); };
  assert.deepEqual(await outcome(g.run("Page.captureScreenshot", {}, send("Page.captureScreenshot"))), { error: DIALOG_HOLDS });
  assert.deepEqual(await outcome(g.run("Input.dispatchKeyEvent", {}, send("Input.dispatchKeyEvent"))), { error: DIALOG_HOLDS });
  assert.deepEqual(await g.run("Page.stopScreencast", {}, send("Page.stopScreencast")), {});
  assert.deepEqual(await g.run("Page.startScreencast", { format: "jpeg", maxWidth: 730 }, send("Page.startScreencast")), {});
  assert.deepEqual(sent, []);
  // The dialog's own answer always goes through.
  assert.deepEqual(await g.run("Page.handleJavaScriptDialog", { accept: false }, async () => ({})), {});
  g.closed();
  await tick();
  assert.deepEqual(applied, [["Page.startScreencast", { format: "jpeg", maxWidth: 730 }]]);
  assert.equal(g.open, false);
});
