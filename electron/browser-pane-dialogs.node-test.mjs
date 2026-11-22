import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { RESTORE_PROMPT, takeDialogs } from "./browser-pane-dialogs.mjs";

function page() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let boxes = 0;
  // Electron's own listener: its native message box.
  contents.on("-run-dialog", () => { boxes++; });
  return { contents, boxes: () => boxes };
}

test("never draws Electron's own box: the dialog waits for CDP's answer, from the bot or the panel", () => {
  const { contents, boxes } = page();
  const timers = [];
  let opened = false;
  const dialogs = takeDialogs(contents, { opened: () => opened, setTimer: (run) => timers.push(run) });
  const answers = [];
  contents.emit("-run-dialog", { dialogType: "confirm", messageText: "Delete?" }, (ok, text) => answers.push([ok, text]));
  opened = true;
  for (const run of timers) run();
  assert.equal(boxes(), 0);
  // CDP answered (Page.handleJavaScriptDialog); Electron's callback is spent, never called again.
  dialogs.closed();
  assert.deepEqual(answers, []);
});

test("dismisses a dialog CDP never reported, so the page never waits on one nobody sees", () => {
  const { contents } = page();
  const timers = [];
  takeDialogs(contents, { opened: () => false, setTimer: (run, ms) => timers.push([run, ms]) });
  const answers = [];
  contents.emit("-run-dialog", { dialogType: "alert" }, (ok, text) => answers.push([ok, text]));
  assert.equal(timers[0][1], 2_000);
  timers[0][0]();
  assert.deepEqual(answers, [[false, ""]]);
});

test("lets go of every held dialog when Electron cancels them or the pane closes", () => {
  const { contents } = page();
  const dialogs = takeDialogs(contents, { opened: () => true, setTimer: () => {} });
  const answers = [];
  contents.emit("-run-dialog", {}, (ok) => answers.push(ok));
  contents.emit("-cancel-dialogs");
  contents.emit("-run-dialog", {}, (ok) => answers.push(ok));
  dialogs.dispose();
  assert.deepEqual(answers, [false, false]);
  assert.equal(contents.listenerCount("-run-dialog"), 0);
});

test("says so when this Electron has no dialog event to take", () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const warnings = [];
  takeDialogs(contents, { opened: () => false, warn: (line) => warnings.push(line), setTimer: () => {} });
  assert.equal(warnings.length, 1);
});

test("gives a top page Chromium's own prompt back, and leaves frames alone", () => {
  assert.match(RESTORE_PROMPT, /window !== window\.top/);
  assert.match(RESTORE_PROMPT, /contentWindow\.prompt/);
});

test("dismisses the dialog a page waits on when asked, as a dismissed box would be", () => {
  const { contents } = page();
  const dialogs = takeDialogs(contents, { opened: () => true, setTimer: () => {} });
  const answers = [];
  assert.equal(dialogs.waiting, false);
  contents.emit("-run-dialog", { dialogType: "alert" }, (ok, text) => answers.push([ok, text]));
  assert.equal(dialogs.waiting, true);
  dialogs.dismiss();
  assert.deepEqual(answers, [[false, ""]]);
  assert.equal(dialogs.waiting, false);
});
