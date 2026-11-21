import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { watchLaunchWork } from "./launch-probes.mjs";
import { createLaunchRecord, RETRY_AFTER_MS, SEND_AFTER_SHOWN_MS } from "./launch-record.mjs";

const START = 1_800_000_000_000;

function fixture({ answers = [] } = {}) {
  const state = { clock: START, timers: [], posts: [], finished: 0 };
  const watch = watchLaunchWork({ now: () => state.clock });
  const finish = watch.finish;
  watch.finish = () => { state.finished += 1; return finish(); };
  const record = createLaunchRecord({
    processStart: START, launchId: "launch-0001", appVersion: "0.1.170", platform: "darwin", arch: "arm64", now: () => state.clock, watch,
    setTimer: (run, ms) => { state.timers.push({ run, ms }); },
  });
  record.deliverWith(async (part) => {
    state.posts.push(part);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: true, complete: false };
  });
  const runTimer = async () => { const timer = state.timers.shift(); timer.run(); await new Promise((resolve) => setImmediate(resolve)); return timer.ms; };
  return { state, record, watch, runTimer };
}

function fakeWindow(app) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.shows = 0;
  win.show = () => { win.shows += 1; };
  app.emit("browser-window-created", {}, win);
  return win;
}
const navigate = (win, url, extra = {}) => win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url, ...extra });

test("a mark is the first time its step is reached, counted from the process's start", () => {
  const { state, record } = fixture();
  state.clock = START + 180.4;
  record.mark("ready");
  state.clock = START + 900;
  record.mark("ready");
  record.begin("lease");
  state.clock += 25;
  record.end("lease");
  record.end("never-begun");
  assert.deepEqual(record.part(), {
    from: "main", launchId: "launch-0001", processStart: START, appVersion: "0.1.170", platform: "darwin", arch: "arm64", hidden: false,
    marks: { ready: 180 }, spans: { lease: 25 }, children: [], net: {},
  });
});

test("a timed step hands back its own result or its own failure", async () => {
  const { state, record } = fixture();
  const pending = record.span("keychain", async () => { state.clock += 12; return { key: "kept" }; });
  assert.deepEqual(await pending, { key: "kept" });
  await assert.rejects(record.span("lease", () => { throw new Error("locked"); }), /locked/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(record.part().spans, { keychain: 12, lease: 0 });
});

test("the splash and the main window are told apart by what they load, and shown is the call that shows them", () => {
  const { state, record } = fixture();
  const app = new EventEmitter();
  record.watchWindows(app);
  state.clock = START + 250;
  const splash = fakeWindow(app);
  navigate(splash, "data:text/html;charset=utf-8,%3C!doctype");
  state.clock = START + 330;
  splash.show();
  state.clock = START + 420;
  splash.emit("show");
  state.clock = START + 850;
  const main = fakeWindow(app);
  navigate(main, "http://127.0.0.1:8799/#frame", { isMainFrame: false });
  navigate(main, "http://127.0.0.1:8799/#same", { isSameDocument: true });
  state.clock = START + 855;
  navigate(main, "http://127.0.0.1:8799/");
  state.clock = START + 990;
  main.show();
  state.clock = START + 5_000;
  const later = fakeWindow(app);
  navigate(later, "https://omb-u-1.fly.dev/");
  later.show();
  assert.deepEqual(record.part().marks, { splashMade: 250, splashShown: 330, windowMade: 850, windowNavigated: 855, windowShown: 990 });
  assert.deepEqual([splash.shows, main.shows, later.shows], [1, 1, 1]);
  assert.deepEqual(state.timers.map((timer) => timer.ms), [SEND_AFTER_SHOWN_MS]);
});

test("a window shown before it loads anything is marked once it is known to be the main window", () => {
  const { state, record } = fixture();
  const app = new EventEmitter();
  record.watchWindows(app);
  state.clock = START + 700;
  const main = fakeWindow(app);
  main.emit("show");
  state.clock = START + 760;
  navigate(main, "https://omb-u-1.fly.dev/");
  assert.deepEqual(record.part().marks, { windowMade: 700, windowNavigated: 760, windowShown: 760 });
});

test("the part goes once after the window shows; the server saying the record is written ends it", async () => {
  const { state, record, runTimer } = fixture({ answers: [{ ok: true, complete: true }] });
  const app = new EventEmitter();
  record.watchWindows(app);
  record.serverReady();
  assert.equal(state.timers.length, 0);
  const main = fakeWindow(app);
  navigate(main, "http://127.0.0.1:8799/");
  main.show();
  main.show();
  record.serverReady();
  assert.equal(state.timers.length, 1);
  assert.equal(await runTimer(), SEND_AFTER_SHOWN_MS);
  assert.equal(state.posts.length, 1);
  assert.equal(record.done, true);
  assert.equal(state.finished, 1);
  record.serverReady();
  fakeWindow(app).show();
  assert.equal(state.timers.length, 0);
});

test("a server that is late, or restarts before the record is written, is asked again a bounded number of times", async () => {
  const { state, record, runTimer } = fixture({ answers: [new Error("not running"), { ok: true, complete: false }, { ok: true, complete: true }] });
  record.setHidden(true);
  record.serverReady();
  const waits = [await runTimer(), await runTimer(), await runTimer()];
  assert.deepEqual(waits, [SEND_AFTER_SHOWN_MS, RETRY_AFTER_MS[0], RETRY_AFTER_MS[1]]);
  assert.equal(state.posts.length, 3);
  assert.equal(state.posts[2].hidden, true);
  assert.equal(record.done, true);
  assert.equal(state.timers.length, 0);
});

test("a launch whose hand-over never works stops trying, puts the probes back and throws nowhere", async () => {
  const failures = Array.from({ length: 10 }, () => new Error("not running"));
  const { state, record, runTimer } = fixture({ answers: failures });
  record.setHidden(true);
  record.serverReady();
  record.serverReady();
  const waits = [];
  while (state.timers.length) waits.push(await runTimer());
  assert.deepEqual(waits, [SEND_AFTER_SHOWN_MS, ...RETRY_AFTER_MS]);
  assert.equal(state.posts.length, RETRY_AFTER_MS.length + 1);
  assert.equal(record.done, true);
  assert.equal(state.finished, 1);
  record.serverReady();
  assert.equal(state.timers.length, 0);
});

test("the part carries the launch id it is given once the main process has made one", () => {
  const record = createLaunchRecord({ processStart: START, appVersion: "0.1.170", platform: "darwin", arch: "arm64" });
  assert.equal(record.part().launchId, null);
  record.setLaunchId("launch-0002");
  assert.equal(record.part().launchId, "launch-0002");
});

test("a launch given up on puts the probes back once and sends nothing more", async () => {
  const { state, record } = fixture();
  record.setHidden(true);
  record.giveUp();
  record.giveUp();
  assert.equal(state.finished, 1);
  assert.equal(record.done, true);
  record.serverReady();
  assert.equal(state.timers.length, 0);
  assert.equal(state.posts.length, 0);
});

test("with nowhere to send it, the record costs marks only", async () => {
  const state = { timers: [] };
  const record = createLaunchRecord({ processStart: START, launchId: "launch-0001", appVersion: "0.1.170", platform: "darwin", arch: "arm64", setTimer: (run, ms) => { state.timers.push({ run, ms }); } });
  record.setHidden(true);
  record.serverReady();
  state.timers.shift().run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.timers.length, 0);
  assert.equal(record.done, false);
});
