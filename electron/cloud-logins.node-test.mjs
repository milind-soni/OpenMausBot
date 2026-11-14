import assert from "node:assert/strict";
import test from "node:test";

import { botsOnCloud, createLoginHandoffClient } from "./cloud-logins.mjs";

const TOKEN = "ops_fake-node-test-token";

test("the private ask takes its answer only from the process it asked, and gives up in words", async () => {
  const sent = [];
  const proc = { postMessage: (message) => sent.push(message) };
  const other = { postMessage() {} };
  const client = createLoginHandoffClient({ timeoutMs: 50, randomId: () => "request-0001" });
  const asked = client.request(proc, { kind: "1password" });
  assert.deepEqual(sent, [{ type: "openmausbot:login-handoff", requestId: "request-0001", what: { kind: "1password" } }]);
  assert.equal(client.receive(other, { type: "openmausbot:login-handoff-result", requestId: "request-0001", ok: true, onePassword: { token: "ops_impostor", grants: {} } }), true);
  assert.equal(client.receive(proc, { type: "something-else" }), false);
  client.receive(proc, { type: "openmausbot:login-handoff-result", requestId: "request-0001", ok: true, onePassword: { token: TOKEN, grants: {} } });
  assert.equal((await asked).onePassword.token, TOKEN);

  const refused = createLoginHandoffClient({ timeoutMs: 50, randomId: () => "request-0002" });
  const gone = refused.request(proc, { kind: "login", id: "x" });
  refused.receive(proc, { type: "openmausbot:login-handoff-result", requestId: "request-0002", ok: false, error: "This login is no longer saved on this computer." });
  await assert.rejects(gone, /no longer saved on this computer/);
  await assert.rejects(createLoginHandoffClient({ timeoutMs: 20 }).request(proc, { kind: "1password" }), /did not answer/);
  await assert.rejects(createLoginHandoffClient().request(null, { kind: "1password" }), /not running/);
});

test("a saved secret's answer is taken like a login's, only from the process asked", async () => {
  const client = createLoginHandoffClient({ randomId: () => "request-0001" });
  const posted = [];
  const proc = { postMessage: (message) => posted.push(message) };
  const answer = client.request(proc, { kind: "secret", id: "s1" });
  assert.deepEqual(posted[0].what, { kind: "secret", id: "s1" });
  client.receive(proc, { type: "openmausbot:login-handoff-result", requestId: "request-0001", ok: true, secret: { id: "s1", value: "sk_fake" } });
  assert.deepEqual((await answer).secret, { id: "s1", value: "sk_fake" });
});

test("a login kept to some bots keeps only those My Cloud has, and every bot stays every bot", () => {
  const cloud = new Set(["quill", "pepper"]);
  assert.equal(botsOnCloud("all", cloud), "all");
  assert.deepEqual(botsOnCloud(["pepper", "ember"], cloud), ["pepper"]);
  assert.deepEqual(botsOnCloud(["ember"], cloud), []);
  assert.deepEqual(botsOnCloud(undefined, cloud), []);
});
