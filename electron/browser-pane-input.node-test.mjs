import assert from "node:assert/strict";
import test from "node:test";

import { createEchoes, echoesOf } from "./browser-pane-input.mjs";

test("the bot's own click and keys are its own, and a person's key right after is the person's", () => {
  let clock = 1000;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 60 });
  assert.equal(echoes.take({ type: "mouseDown", x: 40, y: 60 }), true);
  // A second press during the bot's command is not the bot's: one command, one event.
  assert.equal(echoes.take({ type: "mouseDown", x: 300, y: 300 }), false);
  done();
  clock += 3;
  const release = echoes.expect("Input.dispatchMouseEvent", { type: "mouseReleased", x: 40, y: 60 });
  release();
  // The measured cases: a person's key 22 ms and 102 ms after the bot's mouseUp.
  clock += 22;
  assert.equal(echoes.take({ type: "keyDown" }), false);
  clock += 80;
  assert.equal(echoes.take({ type: "rawKeyDown" }), false);
});

test("a key the bot types is used up once, its character too, and nothing is left for later", () => {
  let clock = 0;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
  assert.equal(echoes.take({ type: "rawKeyDown" }), true);
  assert.equal(echoes.take({ type: "char" }), true);
  assert.equal(echoes.take({ type: "char" }), false);
  done();
  clock += 20;
  assert.equal(echoes.take({ type: "keyDown" }), false);
  assert.equal(echoes.inFlight, false);
});

test("an event in other units still counts as the bot's while its command runs, never after", () => {
  let clock = 0;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 60 });
  assert.equal(echoes.take({ type: "mouseDown", x: 80, y: 120 }), true);
  done();
  const again = echoes.expect("Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 60 });
  again();
  clock += 1;
  assert.equal(echoes.take({ type: "mouseDown", x: 80, y: 120 }), false);
});

test("names what each command causes", () => {
  assert.deepEqual(echoesOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }), [{ types: ["mouseMove"], x: 1, y: 2 }]);
  assert.deepEqual(echoesOf("Input.insertText", { text: "hello" }), [{ types: ["char"], any: true }]);
  assert.deepEqual(echoesOf("Runtime.evaluate", {}), []);
});

test("a bot's wheel is its own with everything Electron reports for it, and a person's scroll after is the person's", () => {
  let clock = 0;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 400 });
  // Measured on Electron 43: two mouseWheel events and the scroll gesture, its end at most 1 ms after the answer.
  for (const type of ["mouseWheel", "mouseWheel", "gestureScrollBegin", "gestureScrollUpdate"]) assert.equal(echoes.take({ type, x: 200, y: 300 }), true, type);
  clock += 4;
  done();
  clock += 1;
  assert.equal(echoes.take({ type: "gestureScrollUpdate" }), true);
  assert.equal(echoes.take({ type: "gestureScrollEnd" }), true);
  clock += 400;
  assert.equal(echoes.take({ type: "mouseWheel", x: 10, y: 10 }), false);
  assert.equal(echoes.take({ type: "gestureScrollBegin" }), false);
});

test("a person's wheel once the bot's two wheels are in is the person's, though within the window", () => {
  let clock = 0;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 400 });
  // Electron 43's wheel events carry no point.
  for (const type of ["mouseWheel", "gestureScrollBegin", "gestureScrollUpdate"]) assert.equal(echoes.take({ type }), true, type);
  done();
  clock += 1;
  assert.equal(echoes.take({ type: "mouseWheel" }), true);
  assert.equal(echoes.take({ type: "gestureScrollEnd" }), true);
  clock += 2;
  assert.equal(echoes.take({ type: "mouseWheel" }), false);
});

test("the window is 20 ms: within it a person's wheel before the bot's second one counts as the bot's, after it the person's", () => {
  let clock = 0;
  const echoes = createEchoes(() => clock);
  const done = echoes.expect("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 400 });
  assert.equal(echoes.take({ type: "mouseWheel" }), true);
  done();
  clock += 15;
  assert.equal(echoes.take({ type: "mouseWheel" }), true);
  const again = echoes.expect("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 400 });
  assert.equal(echoes.take({ type: "mouseWheel" }), true);
  again();
  clock += 25;
  // The bot's second wheel never came in time: a person's wheel 25 ms after is the person's.
  assert.equal(echoes.take({ type: "mouseWheel" }), false);
  assert.equal(echoes.take({ type: "gestureScrollBegin" }), false);
});
