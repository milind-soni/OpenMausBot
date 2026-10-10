import assert from "node:assert/strict";
import test from "node:test";
import { createTrialNotices, localDay, trialNoticeState } from "./cloud-trial-notice.mjs";

const HOUR = 3600_000, DAY = 24 * HOUR;
// Noon local time, so adding hours stays on the same day unless a test means otherwise.
const NOON = new Date(2026, 9, 13, 12, 0, 0).getTime();
const trial = (state, endsAt, extra = {}) => ({ state, tier: "pro", endsAt, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: null, keep: "none", ...extra });
const account = (value, id = "account-1") => ({ status: "connected", account: { id, email: "person@example.test" }, ...(value ? { trial: value } : {}) });

test("an active trial is due only in its last two days; processing only after an hour; the rest whenever the Admin says", () => {
  const endsAt = NOON + 2 * DAY;
  assert.equal(trialNoticeState(trial("active", endsAt), endsAt - 2 * DAY - 1), null, "more than two days left");
  assert.equal(trialNoticeState(trial("active", endsAt), endsAt - 2 * DAY), "active");
  assert.equal(trialNoticeState(trial("active", endsAt), endsAt - HOUR), "active");
  assert.equal(trialNoticeState(trial("processing", endsAt), endsAt + HOUR - 1), null, "most cards settle within the hour");
  assert.equal(trialNoticeState(trial("processing", endsAt), endsAt + HOUR), "processing");
  for (const state of ["ending", "late", "ended"]) assert.equal(trialNoticeState(trial(state, endsAt), endsAt - 6 * DAY), state);
  for (const value of [null, undefined, trial("paused", endsAt), trial("toString", endsAt), { ...trial("ended", endsAt), endsAt: "soon" }]) {
    assert.equal(trialNoticeState(value, NOON), null);
  }
});

test("each notice shows at most once a day, on whichever page asks first, and again the next day while it is due", () => {
  let now = NOON, saved = null;
  const writes = [];
  const notices = createTrialNotices({ read: () => saved, write: value => { writes.push(value); saved = structuredClone(value); }, now: () => now });
  const ended = account(trial("ended", NOON - DAY, { deleteAt: NOON + 2 * DAY, keep: "checkout" }));
  assert.equal(notices.due(ended), "ended");
  notices.seen(ended);
  assert.equal(notices.due(ended), null, "shown today");
  notices.seen(ended);
  assert.equal(writes.length, 1, "one record per showing");
  // The record is today's only, and names no account.
  assert.equal(saved.day, localDay(now)); assert.equal(saved.shown.length, 1);
  assert.ok(!JSON.stringify(saved).includes("account-1"));
  // A restart reads it back: still shown today.
  const restarted = createTrialNotices({ read: () => saved, write: value => { saved = value; }, now: () => now });
  assert.equal(restarted.due(ended), null);
  // Another state of the same trial is another notice.
  const late = account(trial("late", NOON - 4 * DAY, { deleteAt: NOON + 3 * DAY, keep: "portal" }));
  assert.equal(restarted.due(late), "late");
  // The next day it shows once more while it is still due.
  now += DAY;
  assert.equal(notices.due(ended), "ended");
  assert.equal(restarted.due(ended), "ended");
});

test("an active trial's notice in its last two days shows once each day; a new trial or account is a new notice", () => {
  let now = NOON, saved = null;
  const notices = createTrialNotices({ read: () => saved, write: value => { saved = value; }, now: () => now });
  const endsAt = NOON + 2 * DAY + 2 * HOUR;
  const active = account(trial("active", endsAt));
  assert.equal(notices.due(active), null, "more than two days left");
  now = endsAt - 2 * DAY;
  assert.equal(notices.due(active), "active"); notices.seen(active);
  assert.equal(notices.due(active), null);
  now += DAY; assert.equal(notices.due(active), "active");
  // The same state for another account, or another trial (a new end), is not the one seen.
  notices.seen(active);
  assert.equal(notices.due(account(trial("active", endsAt), "account-2")), "active");
  assert.equal(notices.due(account(trial("active", endsAt + HOUR))), "active");
});

test("nothing is due without a verified session and a trial; a broken record never stops a notice or the app", () => {
  const notices = createTrialNotices({ read: () => { throw new Error("unreadable"); }, write: () => { throw new Error("read-only disk"); }, now: () => NOON });
  const ended = account(trial("ended", NOON - DAY));
  for (const state of [null, undefined, { status: "signed-out" }, { status: "unavailable", trial: ended.trial, account: ended.account },
    { ...ended, status: "reauth-required" }, account(null), { status: "connected", trial: ended.trial }]) {
    assert.equal(notices.due(state), null, JSON.stringify(state));
    assert.doesNotThrow(() => notices.seen(state));
  }
  assert.equal(notices.due(ended), "ended");
  assert.doesNotThrow(() => notices.seen(ended));
  assert.equal(notices.due(ended), null, "kept in memory when the file cannot be written");
  // A record from another day, or one that is not ours, shows nothing as seen.
  for (const saved of [{ day: "2020-01-01", shown: ["0".repeat(32)] }, { day: localDay(NOON), shown: "all" }, { day: localDay(NOON), shown: [42, "<b>"] }, "nonsense"]) {
    assert.equal(createTrialNotices({ read: () => saved, write: () => {}, now: () => NOON }).due(ended), "ended");
  }
});
