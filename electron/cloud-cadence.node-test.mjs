import assert from "node:assert/strict";
import test from "node:test";

import { createBackoff, jittered, jitteredAbove, jitteredBelow, retryWait, SESSION_RETRY_AFTER_MAX_MS, sessionRetryWait } from "./cloud-cadence.mjs";

test("spreads: ±20% around, only sooner, only later; a draw of 0.5 leaves a wait as it is (only later: +10%)", () => {
  for (const [drawn, around, sooner, later] of [[0, 80, 80, 100], [0.5, 100, 100, 110], [1, 120, 80, 120], [Number.NaN, 100, 100, 100], [7, 120, 80, 120]]) {
    assert.equal(jittered(100_000, () => drawn), around * 1_000, `around ${drawn}`);
    assert.equal(jitteredBelow(100_000, () => drawn), sooner * 1_000, `sooner ${drawn}`);
    assert.equal(jitteredAbove(100_000, () => drawn), later * 1_000, `later ${drawn}`);
  }
});

test("a Retry-After is kept, spread only later, and held to its cap (an hour, five minutes for the session)", () => {
  const low = () => 0;
  assert.equal(retryWait(1, { retryAfter: 600, random: low }), 600_000, "longer than the 1-minute step");
  assert.equal(retryWait(1, { retryAfter: 600, random: () => 1 }), 720_000);
  assert.equal(retryWait(1, { retryAfter: 30, random: low }), 48_000, "shorter than the step: the step");
  assert.equal(retryWait(1, { retryAfter: 86_400, random: low }), 3_600_000, "a day asked for: an hour");
  assert.equal(retryWait(1, { retryAfter: 86_400, retryAfterMax: 300_000, random: low }), 300_000);
  for (const bad of [0, -5, Number.NaN, undefined, "600"]) assert.equal(retryWait(1, { retryAfter: bad, random: () => 0.5 }), 60_000, String(bad));
  assert.equal(sessionRetryWait(1, { retryAfter: 3_600, verifiedIn: 900_000, random: low }), SESSION_RETRY_AFTER_MAX_MS, "the session's is held to five minutes");
  assert.equal(sessionRetryWait(1, { retryAfter: 3_600, verifiedIn: 140_000, random: low }), 120_000, "and never past 20 s before the verified answer stops counting");
  assert.equal(sessionRetryWait(1, { retryAfter: 3_600, verifiedIn: 900_000, attended: true, random: () => 1 }), 60_000, "and to a minute while someone looks");
});

test("the session's failure waits: who is looking decides how long", () => {
  const steps = (options) => [1, 2, 3, 4, 5, 6, 7].map((failures) => sessionRetryWait(failures, { verifiedIn: 3_600_000, random: () => 0.5, ...options }));
  assert.deepEqual(steps({}), [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.deepEqual(steps({ attended: true }), [15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(steps({ waking: true }), Array(7).fill(15_000));
  assert.ok(steps({ attended: true, random: () => 1 }).every((wait) => wait <= 60_000), "looking: never longer than a minute, whatever the draw");
  assert.equal(sessionRetryWait(3, { expiresIn: 5_000, verifiedIn: 3_600_000, random: () => 0.5 }), 5_000, "never past the sign-in's expiry");
});

test("a backoff grows with each failure, and an answer starts it again", () => {
  let clock = 0;
  const backoff = createBackoff({ steps: [60_000, 120_000, 300_000], now: () => clock, random: () => 0.5 });
  assert.equal(backoff.waiting(), false);
  assert.equal(backoff.failed(), 60_000);
  assert.equal(backoff.waiting(), true);
  assert.equal(backoff.failed(), 120_000);
  assert.equal(backoff.failed(), 300_000);
  assert.equal(backoff.failed(), 300_000, "the last step from then on");
  clock = 299_999; assert.equal(backoff.waiting(), true);
  clock = 300_000; assert.equal(backoff.waiting(), false);
  backoff.ok();
  assert.equal(backoff.until(), 0);
  assert.equal(backoff.failed() - clock, 60_000, "an answer starts the count again");
  assert.equal(backoff.failed({ retryAfter: 900 }) - clock, 990_000, "and a Retry-After counts");
});
