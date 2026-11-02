import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostScreenLease, screenCheckFailedText } from "./host-screen-lease.mjs";

const answer = (status, body) => async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lease = fetch => createHostScreenLease({ fetch, url: () => "http://127.0.0.1:1/api/desktop/shared-computer-control", timeoutMs: 200 });
const refusal = async fetch => {
  try { await lease(fetch)("5d0c7a39-2b39-4b07-9a0e-0c58a7d55f21", new AbortController().signal); } catch (error) { return error.message; }
  return null;
};

test("a busy screen and an organization's policy reach the bot as the server said them", async () => {
  const busy = "Another bot on this computer, Researcher, is using its screen right now, so this call was not performed. It is not a person.";
  assert.equal(await refusal(answer(409, { error: busy, code: "bot" })), busy);
  assert.equal(await refusal(answer(403, { error: "Acme does not allow bots to use this computer.", code: "managed_policy" })), "Acme does not allow bots to use this computer.");
});

test("a screen check that fails says so, and never that a person is using the computer", async () => {
  const cases = [
    [answer(404, { error: "no route: POST /api/desktop/shared-computer-control" }), /its server answered 404: no route/],
    [answer(403, { error: "Local desktop only" }), /its server answered 403: Local desktop only/],
    [answer(401, { error: "unauthorized" }), /its server answered 401/],
    [answer(500), /its server answered 500\)/],
    [answer(400, { error: "Invalid computer lease" }), /its server answered 400/],
    [async () => { throw new TypeError("fetch failed"); }, /its server could not be reached/],
    [(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))), /its server did not answer within 0.2 seconds/],
  ];
  for (const [fetch, detail] of cases) {
    const said = await refusal(fetch);
    assert.match(said, detail);
    assert.match(said, /^OpenMausBot on this computer could not check whether its screen is free \(.*\), so this call was not performed\. This is not a person using the computer\./);
    assert.doesNotMatch(said, /held by a person|in use locally/);
  }
  assert.match(screenCheckFailedText("x"), /quit and reopen OpenMausBot/);
});

test("an acquired lease renews with acquire and releases, sending the desktop's own capability", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push([url, init.headers["X-Test"], JSON.parse(init.body).action]); return new Response("{\"ok\":true}", { status: 200 }); };
  const control = await createHostScreenLease({ fetch, url: () => "http://127.0.0.1:9/lock", headers: () => ({ "X-Test": "cap" }) })("id", new AbortController().signal);
  await control.renew(); await control.release();
  assert.deepEqual(sent, [["http://127.0.0.1:9/lock", "cap", "acquire"], ["http://127.0.0.1:9/lock", "cap", "acquire"], ["http://127.0.0.1:9/lock", "cap", "release"]]);
});

test("a call ended by its own turn passes the abort on instead of blaming the server", async () => {
  const stop = new AbortController();
  const fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const pending = lease(fetch)("id", stop.signal);
  stop.abort(new Error("the turn ended"));
  await assert.rejects(pending, /the turn ended/);
});
