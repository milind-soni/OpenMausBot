import assert from "node:assert/strict";
import test from "node:test";

import { createSupportOutbox, diagnosticsByDefault, MAX_OUTBOX, replyAddress, RETRY_MS, supportBody, supportOutcome } from "./support-request.mjs";

const FACTS = { place: "desktop", appVersion: "0.1.153", platform: "darwin arm64, desktop app" };
const FORM = { topic: "billing", message: "I was charged twice.", replyTo: "Me@Example.test" };

/** An outbox on a clock and a timer driven by hand; `answers` are what each attempt gets, in order (null: never reached). */
function outbox({ answers = [], account = "a1", saved } = {}) {
  let now = 1_000_000, written = saved, pending = null;
  const sent = [];
  const box = createSupportOutbox({
    store: { read: () => { if (written === undefined) throw new Error("none"); return structuredClone(written); }, write: (value) => { written = structuredClone(value); } },
    send: async (body) => { sent.push(body); return answers.length ? answers.shift() : null; },
    account: () => account, now: () => now,
    setTimer: (run, ms) => { pending = { run, at: now + ms }; return pending; }, clearTimer: () => { pending = null; },
  });
  return { box, sent, written: () => written, tick: async (ms) => { now += ms; if (pending && pending.at <= now) { const { run } = pending; pending = null; run(); await box.flush(); } },
    switchTo: (id) => { account = id; } };
}

test("the page's form becomes the intake's body: checked, the reply-to lower-cased, and main's place and version", () => {
  assert.deepEqual(supportBody({ ...FORM, diagnostics: "MausBot 0.1.153", priority: false, account: "someone" }, FACTS),
    { kind: "support", topic: "billing", message: "I was charged twice.", replyTo: "me@example.test", appVersion: "0.1.153", platform: "darwin arm64, desktop app", place: "desktop",
      diagnostics: "MausBot 0.1.153" });
  assert.equal(supportBody(FORM, { ...FACTS, place: "../elsewhere" }).place, undefined, "a place main doesn't know is left out");
  assert.equal(supportBody({ ...FORM, diagnostics: "  " }, FACTS).diagnostics, undefined);
  for (const bad of [{ topic: "refunds" }, { message: " " }, { message: "x".repeat(5_001) }, { replyTo: "me@example.test\r\nBcc: x@example.test" }, { replyTo: "a, b@example.test" }, { replyTo: "" }]) {
    assert.throws(() => supportBody({ ...FORM, ...bad }, FACTS), Error, JSON.stringify(bad));
  }
  assert.equal(supportBody({ ...FORM, message: "x".repeat(5_000) }, FACTS).message.length, 5_000);
  assert.equal(replyAddress(" A@B.example "), "a@b.example");
  assert.equal(replyAddress(`${"a".repeat(65)}@example.test`), null);
});

test("diagnostics start on only for something that isn't working, never for billing", () => {
  assert.deepEqual(["billing", "broken", "question", "other", ""].map(diagnosticsByDefault), [false, true, false, false, false]);
});

test("reads every answer the intake gives", () => {
  assert.deepEqual(supportOutcome({ status: 201, body: { id: "r-1", priority: true } }), { outcome: "sent", id: "r-1" });
  assert.deepEqual(supportOutcome({ status: 200, body: { accepted: false, code: "support_off", supportEmail: "help@example.test" } }), { outcome: "off", email: "help@example.test" });
  assert.deepEqual(supportOutcome({ status: 401, body: {} }), { outcome: "signin" });
  assert.deepEqual(supportOutcome({ status: 403, body: { error: "Contact support is for accounts with a paid Cloud or Team plan." } }), { outcome: "unavailable" });
  assert.deepEqual(supportOutcome({ status: 400, body: { error: "Write your message\r\nin 1 to 5,000 characters." } }), { outcome: "refused", detail: "Write your message in 1 to 5,000 characters." });
  for (const answer of [null, { status: 429, body: {} }, { status: 502, body: {} }, { status: 201, body: { id: "../bad" } }]) assert.deepEqual(supportOutcome(answer), { outcome: "retry" });
});

test("a message that can't go now is saved and goes by itself on the retry schedule, as its own account only", async () => {
  const world = outbox({ answers: [null, { status: 502, body: {} }, { status: 201, body: { id: "r-9" } }] });
  const body = supportBody(FORM, FACTS);
  assert.deepEqual(await world.box.submit(body), { outcome: "queued" });
  assert.equal(world.box.waiting(), 1);
  assert.deepEqual(world.written().waiting.map(({ account, attempts }) => ({ account, attempts })), [{ account: "a1", attempts: 1 }]);
  await world.tick(RETRY_MS[0] - 1);
  assert.equal(world.sent.length, 1, "nothing before it is due");
  await world.tick(1);
  assert.equal(world.sent.length, 2);
  assert.equal(world.box.waiting(), 1, "a server error: still waiting");
  // Another account signed in meanwhile: the message waits for its own.
  world.switchTo("b2");
  await world.tick(RETRY_MS[1]);
  assert.equal(world.sent.length, 2);
  world.switchTo("a1");
  await world.tick(RETRY_MS[0]);
  assert.equal(world.sent.length, 3);
  assert.deepEqual(world.sent.at(-1), body);
  assert.equal(world.box.waiting(), 0);
  assert.deepEqual(world.written().waiting, []);
});

test("sends at once when it can, keeps nothing it shouldn't, and saved messages survive a restart", async () => {
  const sent = outbox({ answers: [{ status: 201, body: { id: "r-1" } }] });
  assert.deepEqual(await sent.box.submit(supportBody(FORM, FACTS)), { outcome: "sent", id: "r-1" });
  assert.equal(sent.box.waiting(), 0);
  for (const [answer, result] of [[{ status: 403, body: {} }, { outcome: "unavailable" }], [{ status: 200, body: { accepted: false, supportEmail: "help@example.test" } }, { outcome: "off", email: "help@example.test" }]]) {
    const world = outbox({ answers: [answer] });
    assert.deepEqual(await world.box.submit(supportBody(FORM, FACTS)), result);
    assert.equal(world.box.waiting(), 0);
  }
  assert.deepEqual(await outbox({ account: null }).box.submit(supportBody(FORM, FACTS)), { outcome: "signin" });
  const full = outbox();
  for (let index = 0; index < MAX_OUTBOX; index++) assert.deepEqual(await full.box.submit(supportBody(FORM, FACTS)), { outcome: "queued" });
  assert.deepEqual(await full.box.submit(supportBody(FORM, FACTS)), { outcome: "full" });
  const restarted = outbox({ saved: full.written(), answers: [{ status: 201, body: { id: "r-2" } }] });
  assert.equal(restarted.box.waiting(), MAX_OUTBOX);
  await restarted.tick(RETRY_MS[0]);
  assert.equal(restarted.box.waiting(), MAX_OUTBOX - 1);
});
