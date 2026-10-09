import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRO_PLAN_ENV, PRO_PLAN_MESSAGE, createProPlanRelay, liveCallsAllowed,
  proPlanEnvironment, proPlanFromEnvironment, proPlanFromMessage, proPlanMessage,
} from "./pro-plan.mjs";

const active = tier => ({ plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: 1_900_000_000_000, version: 2 });
const lapsed = { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 };
const free = { plan: "free", status: "inactive", expiresAt: null, version: 1 };
const connected = extra => ({ status: "connected", account: { id: "a", email: "person@example.test" }, deviceId: "d", expiresAt: 1_900_000_000_000, ...extra });
const restoring = { status: "signed-out", message: "restoring" };

// Every plan state Settings → OpenMausBot Cloud can show (src/lib/cloud-plan.ts
// cloudPlanView), with and without a last known Pro answer, and a Cloud home.
const TABLE = [
  // Verified by OpenMausBot Cloud: the answer is the plan's own.
  { name: "paid: Personal", account: connected({ entitlement: active("personal") }), allowed: true },
  { name: "paid: Pro", account: connected({ entitlement: active("pro") }), allowed: true },
  { name: "paid: Max", account: connected({ entitlement: active("max") }), allowed: true },
  { name: "paid: an Admin that sells only Pro (no tier)", account: connected({ entitlement: active() }), allowed: true },
  { name: "paid: a tier newer than this app", account: connected({ entitlement: active("team") }), allowed: true },
  { name: "checking: the last verified answer is Pro", account: connected({ entitlement: active("pro"), checking: true }), allowed: true },
  { name: "checking: the last verified answer is free", account: connected({ entitlement: free, checking: true }), lastKnown: true, allowed: false },
  { name: "purchase: a payment received, still linking", account: connected({ entitlement: free, purchase: { state: "confirming", tier: "personal" } }), allowed: true },
  { name: "purchase: held, over a lapsed plan", account: connected({ entitlement: lapsed, purchase: { state: "held" } }), allowed: true },
  { name: "attention: a lapsed plan", account: connected({ entitlement: lapsed }), lastKnown: true, allowed: false },
  { name: "attention: a Cloud still there without a plan", account: connected({ entitlement: free, machine: { status: "payment-problem", origin: "https://home.fly.dev" } }), lastKnown: true, allowed: false },
  { name: "free", account: connected({ entitlement: free }), lastKnown: true, allowed: false },
  { name: "signed out", account: { status: "signed-out" }, lastKnown: true, allowed: false },
  { name: "signed out: a sign-in that ended", account: { status: "signed-out", message: "enrollment-ended" }, lastKnown: true, allowed: false },
  // Cannot be checked right now: the plan last verified decides.
  { name: "unknown: no sign-in state yet", account: null, allowed: false },
  { name: "unknown: no sign-in state yet, last known Pro", account: null, lastKnown: true, allowed: true },
  { name: "unknown: a saved sign-in still restoring", account: restoring, allowed: false },
  { name: "unknown: restoring, last known Pro", account: restoring, lastKnown: true, allowed: true },
  { name: "connecting", account: { status: "connecting" }, allowed: false },
  { name: "connecting, last known Pro", account: { status: "connecting" }, lastKnown: true, allowed: true },
  { name: "unverified: last verified Pro", account: { status: "unavailable", message: "unreachable", lastPlan: { tier: "max", active: true } }, allowed: true },
  { name: "unverified: last verified a lapsed plan", account: { status: "unavailable", message: "unreachable", lastPlan: { tier: "pro", active: false } }, lastKnown: true, allowed: false },
  { name: "unverified: no plan verified", account: { status: "unavailable", message: "restore-failed" }, allowed: false },
  { name: "unverified: no paid plan carried, last known Pro", account: { status: "unavailable", message: "verification-expired" }, lastKnown: true, allowed: true },
  { name: "reauth: last verified Pro", account: { status: "reauth-required", message: "expired", lastPlan: { active: true } }, allowed: true },
  { name: "reauth: last verified a lapsed plan", account: { status: "reauth-required", message: "access-ended", lastPlan: { tier: "max", active: false } }, lastKnown: true, allowed: false },
  { name: "reauth: no plan verified", account: { status: "reauth-required", message: "access-ended" }, allowed: false },
  // The plan's own machine.
  { name: "Cloud home", account: null, cloudHome: true, allowed: true },
  { name: "Cloud home, whatever a sign-in says", account: { status: "signed-out" }, cloudHome: true, allowed: true },
];

for (const row of TABLE) {
  test(`Live calls: ${row.name} → ${row.allowed ? "allowed" : "refused"}`, () => {
    assert.equal(liveCallsAllowed({ account: row.account, lastKnown: row.lastKnown ?? false, cloudHome: row.cloudHome ?? false }), row.allowed);
  });
}

test("a state that cannot say keeps the last known answer, and only that one", () => {
  for (const account of [null, undefined, restoring, { status: "connecting" }, { status: "unavailable", message: "restore-failed" }]) {
    assert.equal(liveCallsAllowed({ account, lastKnown: true }), true, JSON.stringify(account));
    assert.equal(liveCallsAllowed({ account, lastKnown: false }), false, JSON.stringify(account));
    assert.equal(liveCallsAllowed({ account }), false, JSON.stringify(account));
  }
  // a status newer than this app is no plan
  assert.equal(liveCallsAllowed({ account: { status: "paused" }, lastKnown: true }), false);
});

test("Electron keeps the answer across states that cannot say, and forgets it on signing out", () => {
  const relay = createProPlanRelay();
  // Before the Cloud sign-in is read (the server starts first): not Pro.
  assert.deepEqual(relay.environment(), { [PRO_PLAN_ENV]: "0" });
  const steps = [
    [undefined, false], [restoring, false],
    [connected({ entitlement: active("pro") }), true],
    // the sign-in ended, then "Sign in again": the plan last verified holds while signing in
    [{ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, true],
    [{ status: "connecting" }, true],
    [{ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 1 } }, true],
    [connected({ entitlement: free }), false],
    [{ status: "connecting" }, false],
    [connected({ entitlement: free, purchase: { state: "confirming", tier: "max" } }), true],
    [connected({ entitlement: active("max"), checking: true }), true],
    [{ status: "unavailable", message: "verification-expired", lastPlan: { tier: "max", active: true } }, true],
    [{ status: "signed-out" }, false],
    [{ status: "connecting" }, false],
  ];
  for (const [account, pro] of steps) {
    assert.equal(relay.update(account), pro, JSON.stringify(account));
    assert.deepEqual(relay.environment(), { [PRO_PLAN_ENV]: pro ? "1" : "0" });
    assert.deepEqual(relay.message(), { type: PRO_PLAN_MESSAGE, pro });
  }
});

test("what Electron hands its server is the answer only, never the account", () => {
  const relay = createProPlanRelay();
  relay.update(connected({ entitlement: active("max"), machine: { status: "running", origin: "https://home.fly.dev" } }));
  const sent = JSON.stringify([relay.environment(), relay.message()]);
  for (const secret of ["person@example.test", "home.fly.dev", "max", "deviceId"]) assert.ok(!sent.includes(secret), secret);
});

test("the server reads back exactly what Electron sends, at spawn and after", () => {
  assert.equal(PRO_PLAN_ENV, "OMB_PRO_PLAN");
  assert.equal(PRO_PLAN_MESSAGE, "openmausbot:pro-plan");
  for (const pro of [true, false]) {
    assert.equal(proPlanFromEnvironment({ PATH: "/bin", ...proPlanEnvironment(pro) }), pro);
    assert.equal(proPlanFromMessage(proPlanMessage(pro)), pro);
  }
  // A server the desktop app did not start says Pro with OMB_PRO_PLAN=1, and only so.
  assert.equal(proPlanFromEnvironment({ OMB_PRO_PLAN: "1" }), true);
  assert.equal(proPlanFromEnvironment({ OMB_PRO_PLAN: " 1 " }), true);
  for (const value of [undefined, "", "0", "true", "yes", "pro", "2"]) assert.equal(proPlanFromEnvironment({ OMB_PRO_PLAN: value }), false, String(value));
  // Another private message is not this one; a malformed one is refused, never read as an answer.
  for (const other of [undefined, null, "openmausbot:pro-plan", [], { type: "openmausbot:managed-composio", access: null }]) assert.equal(proPlanFromMessage(other), null);
  for (const malformed of [{ type: PRO_PLAN_MESSAGE }, { type: PRO_PLAN_MESSAGE, pro: "yes" }, { type: PRO_PLAN_MESSAGE, pro: 1 }]) {
    assert.throws(() => proPlanFromMessage(malformed), /Pro plan/);
  }
});
