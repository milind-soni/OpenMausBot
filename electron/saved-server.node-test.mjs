import assert from "node:assert/strict";
import test from "node:test";

import { serverAnswers, serverOpens } from "./saved-server.mjs";

const office = { id: "vps", name: "pro cloud", origin: "https://omb-u-gone.fly.dev" };
const answering = (status) => async () => new Response("{}", { status });
const gone = async () => { throw new TypeError("fetch failed"); };
const asked = (responses) => {
  const shown = [];
  return { shown, dialog: { showMessageBox: async (options) => { shown.push(options); return { response: responses.shift() ?? 2 }; } } };
};

test("a server answers with any status but a proxy's 5xx; a name that doesn't resolve, a refused or a slow one doesn't", async () => {
  for (const status of [200, 401, 404]) assert.equal(await serverAnswers(office.origin, answering(status)), true, String(status));
  for (const status of [502, 503]) assert.equal(await serverAnswers(office.origin, answering(status)), false, String(status));
  assert.equal(await serverAnswers(office.origin, gone), false);
  const slow = (_url, init) => new Promise((_, fail) => init.signal.addEventListener("abort", () => fail(init.signal.reason)));
  assert.equal(await serverAnswers(office.origin, slow, 20), false, "no answer within the look");
});

test("the window goes to a server that answers without asking anything", async () => {
  const { shown, dialog } = asked([]);
  assert.equal(await serverOpens(office, { fetch: answering(200), dialog, forget: () => assert.fail("nothing to forget") }), true);
  assert.deepEqual(shown, []);
});

test("one that doesn't answer is the person's choice: Cancel stays put, Remove forgets it, Try again looks once more", async () => {
  const cancel = asked([2]);
  assert.equal(await serverOpens(office, { fetch: gone, dialog: cancel.dialog, forget: () => assert.fail("not asked to") }), false);
  assert.equal(cancel.shown[0].message, "pro cloud isn't answering");
  assert.match(cancel.shown[0].detail, /omb-u-gone\.fly\.dev/);
  assert.deepEqual(cancel.shown[0].buttons, ["Try again", "Remove from list", "Cancel"]);

  const forgotten = [];
  const remove = asked([1]);
  assert.equal(await serverOpens(office, { fetch: gone, dialog: remove.dialog, forget: (id) => forgotten.push(id) }), false);
  assert.deepEqual(forgotten, ["vps"]);

  let tries = 0;
  const back = async () => (++tries < 2 ? gone() : new Response("{}", { status: 200 }));
  const retry = asked([0]);
  assert.equal(await serverOpens(office, { fetch: back, dialog: retry.dialog, forget: () => assert.fail("not asked to") }), true, "it answered the second time");
  assert.equal(retry.shown.length, 1);
});
