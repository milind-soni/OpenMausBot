import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopScreenCapture, createScreenContext, SCREEN_CONTEXT_LIMITS } from "./island-screen-context.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const frame = text => ({ dataUrl: `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`, displayId: "7" });

function harness(captureFrame) {
  let time = 1_000;
  let next = 0;
  const timers = new Map();
  const changes = [];
  const context = createScreenContext({ captureFrame, now: () => time,
    onChange: state => changes.push(state), setTimer: fn => { timers.set(++next, fn); return next; },
    clearTimer: id => timers.delete(id) });
  return { context, timers, changes, advance: ms => { time += ms; }, async tick() {
    const [id, callback] = timers.entries().next().value ?? [];
    assert.ok(callback, "a capture is scheduled");
    timers.delete(id); time += SCREEN_CONTEXT_LIMITS.intervalMs; callback(); await flush();
  } };
}

test("capture is opt-in, bounded, deduplicated and entirely cleared on pause", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return frame(`image-${Math.min(calls, 4)}`); });
  assert.equal(calls, 0);
  assert.equal(h.context.snapshot().active, false);
  h.context.start(); await flush();
  await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.context.frames().length, 3);
  assert.equal(h.context.frames()[0].dataUrl, frame("image-2").dataUrl);
  const capturedAt = h.context.frames().at(-1).capturedAt;
  await h.tick();
  assert.equal(h.context.frames().length, 3);
  assert.ok(h.context.frames().at(-1).capturedAt > capturedAt);
  assert.equal(JSON.stringify(h.context.snapshot()).includes("base64"), false);
  h.context.pause();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.context.frames(), []);
  assert.equal(h.context.snapshot().active, false);
});

test("expired images cannot be attached and callers cannot mutate retained records", async () => {
  const h = harness(async () => frame("one"));
  h.context.start(); await flush();
  h.context.frames()[0].dataUrl = "modified";
  assert.equal(h.context.frames()[0].dataUrl, frame("one").dataUrl);
  h.advance(SCREEN_CONTEXT_LIMITS.ttlMs);
  assert.deepEqual(h.context.frames(), []);
  assert.equal(h.context.snapshot().lastCapturedAt, null);
  h.context.dispose();
});

test("pausing an in-flight capture discards it, restart never overlaps captures", async () => {
  let resolve;
  let calls = 0;
  const h = harness(() => { calls += 1; return new Promise(done => { resolve = done; }); });
  h.context.start(); h.context.start();
  assert.equal(calls, 1);
  h.context.pause(); h.context.start();
  assert.equal(calls, 1);
  resolve(frame("before pause")); await flush();
  assert.deepEqual(h.context.frames(), []);
  const tick = h.tick();
  resolve(frame("after restart")); await tick;
  assert.equal(calls, 2);
  assert.equal(h.context.frames()[0].dataUrl, frame("after restart").dataUrl);
  h.context.dispose(); h.context.start();
  assert.equal(calls, 2);
  assert.equal(h.context.snapshot().active, false);
});

test("capture errors and oversized images erase old context without leaking exception contents", async () => {
  let result = frame("ok");
  const h = harness(async () => { if (result instanceof Error) throw result; return result; });
  h.context.start(); await flush();
  result = Object.assign(new Error("private source content"), { code: "screen-permission-denied" });
  await h.tick();
  assert.deepEqual(h.context.frames(), []);
  assert.equal(h.context.snapshot().error, "screen-permission-denied");
  result = frame("new"); await h.tick();
  assert.equal(h.context.snapshot().error, null);
  result = frame("x".repeat(SCREEN_CONTEXT_LIMITS.maxFrameBytes)); await h.tick();
  assert.equal(h.context.snapshot().error, "capture-unavailable");
  assert.deepEqual(h.context.frames(), []);
  assert.equal(JSON.stringify(h.changes).includes("private"), false);
  h.context.dispose();
});

test("desktop capture follows the pointer display and requests no audio", async () => {
  let options;
  const capture = createDesktopScreenCapture({ platform: "darwin",
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    screen: { getCursorScreenPoint: () => ({ x: 1600, y: 50 }), getDisplayNearestPoint: point => { assert.equal(point.x, 1600); return { id: 7 }; } },
    desktopCapturer: { getSources: async input => { options = input; return [
      { display_id: "1", thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from("wrong") } },
      { display_id: "7", thumbnail: { isEmpty: () => false, toJPEG: quality => { assert.equal(quality, 55); return Buffer.from("right"); } } },
    ]; } },
  });
  assert.deepEqual(await capture(), frame("right"));
  assert.deepEqual(options, { types: ["screen"], thumbnailSize: { width: 960, height: 600 }, fetchWindowIcons: false });
});

test("denied permission and suspension prevent a desktop capture", async () => {
  for (const suspended of [true, false]) {
    const capture = createDesktopScreenCapture({ platform: "darwin", isSuspended: () => suspended,
      systemPreferences: { getMediaAccessStatus: () => "denied" },
      desktopCapturer: { getSources: () => assert.fail("must not capture") } });
    await assert.rejects(capture(), { code: suspended ? "screen-suspended" : "screen-permission-denied" });
  }
});

test("a missing display never silently captures another monitor", async () => {
  const capture = createDesktopScreenCapture({ platform: "linux",
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 7 }) },
    desktopCapturer: { getSources: async () => [{ display_id: "99" }] } });
  await assert.rejects(capture(), /selected display is unavailable/);
});
