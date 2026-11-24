import assert from "node:assert/strict";
import test from "node:test";

import { createCloudFocusWake, FOCUS_WAKE_GAP_MS, focusWakeEnabled, USED_WITHIN_MS } from "./cloud-focus-wake.mjs";

const DAY = 24 * 60 * 60_000;

function fixture({ enabled = true, state = "asleep", usedAt = undefined, client = true } = {}) {
  const world = { now: 10 * DAY, wakes: 0, writes: [], stored: usedAt === undefined ? null : { usedAt }, state };
  const account = { power: () => (world.state ? { state: world.state, since: 1, sleeps: true } : null), wakeHome: async () => { world.wakes += 1; return "awake"; } };
  const wake = createCloudFocusWake({
    enabled: () => enabled,
    account: () => (client ? account : null),
    pref: { read: () => { if (!world.stored) throw new Error("ENOENT"); return world.stored; }, write: (value) => { world.writes.push(value); world.stored = value; } },
    now: () => world.now,
  });
  return { world, wake };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("off unless OMB_CLOUD_FOCUS_WAKE is 1", () => {
  assert.equal(focusWakeEnabled({}), false);
  assert.equal(focusWakeEnabled({ OMB_CLOUD_FOCUS_WAKE: "0" }), false);
  assert.equal(focusWakeEnabled({ OMB_CLOUD_FOCUS_WAKE: "1" }), true);
});

test("wakes My Cloud once on focus when it sleeps and the person used it this week", async () => {
  const { world, wake } = fixture({ usedAt: 10 * DAY - 6 * DAY });
  assert.equal(wake.focused({ shown: true, showingCloud: false }), true);
  await settle();
  assert.equal(world.wakes, 1);
});

test("never on a window that is hidden or minimized, never when switched off, never for a Cloud that is awake or unknown", async () => {
  const recent = 10 * DAY - DAY;
  for (const [options, focus] of [
    [{ usedAt: recent }, { shown: false, showingCloud: false }],
    [{ usedAt: recent, enabled: false }, { shown: true, showingCloud: false }],
    [{ usedAt: recent, state: "awake" }, { shown: true, showingCloud: false }],
    [{ usedAt: recent, state: null }, { shown: true, showingCloud: false }],
    [{ usedAt: recent, client: false }, { shown: true, showingCloud: false }],
  ]) {
    const { world, wake } = fixture(options);
    assert.equal(wake.focused(focus), false, JSON.stringify(options));
    await settle();
    assert.equal(world.wakes, 0);
  }
});

test("never for a person with no record of using My Cloud here, or none in the last 7 days", async () => {
  for (const usedAt of [undefined, 10 * DAY - USED_WITHIN_MS - 1]) {
    const { world, wake } = fixture({ usedAt });
    assert.equal(wake.focused({ shown: true, showingCloud: false }), false);
    await settle();
    assert.equal(world.wakes, 0);
  }
});

test("asks again only after FOCUS_WAKE_GAP_MS, however often the window is focused", async () => {
  const { world, wake } = fixture({ usedAt: 10 * DAY - DAY });
  assert.equal(wake.focused({ shown: true, showingCloud: false }), true);
  world.now += FOCUS_WAKE_GAP_MS - 1;
  assert.equal(wake.focused({ shown: true, showingCloud: false }), false);
  world.now += 1;
  assert.equal(wake.focused({ shown: true, showingCloud: false }), true);
  await settle();
  assert.equal(world.wakes, 2);
});

test("records a use when the window shows My Cloud as it gets or loses focus, and wakes nothing itself then", async () => {
  const { world, wake } = fixture();
  assert.equal(wake.focused({ shown: true, showingCloud: false }), false);
  assert.equal(wake.focused({ shown: true, showingCloud: true }), false);
  assert.deepEqual(world.writes, [{ usedAt: 10 * DAY }]);
  world.now += 60_000;
  wake.blurred({ showingCloud: true });
  assert.equal(world.writes.length, 1, "written at most hourly");
  world.now += 60 * 60_000;
  wake.blurred({ showingCloud: true });
  wake.blurred({ showingCloud: false });
  assert.equal(world.writes.length, 2);
  assert.equal(wake.focused({ shown: true, showingCloud: false }), true);
  await settle();
  assert.equal(world.wakes, 1);
});
