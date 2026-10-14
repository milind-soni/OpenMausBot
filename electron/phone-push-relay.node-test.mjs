import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
} from "./companion-account-service.mjs";
import { PHONE_PUSH_RELAY_MESSAGE, createPhonePushRelay, createPhonePushRelaySync, phonePushRelayMessage } from "./phone-push-relay.mjs";

const CREDENTIAL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const ORIGIN = "https://control.example.test";

test("hands the server the relay origin and installation credential, and nothing else of the account", () => {
  const message = phonePushRelayMessage({
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: CREDENTIAL,
    companionAccountToken: "account-bearer-that-must-not-cross",
    companionAccountEmail: "person@example.test",
  }, ORIGIN);
  assert.deepEqual(message, { type: PHONE_PUSH_RELAY_MESSAGE, access: { controlPlane: ORIGIN, credential: CREDENTIAL } });
  assert.doesNotMatch(JSON.stringify(message), /account-bearer|person@/);
});

test("says there is no access when hosted access is off, signed out, malformed or being removed", () => {
  const none = { type: PHONE_PUSH_RELAY_MESSAGE, access: null };
  assert.deepEqual(phonePushRelayMessage({}, ORIGIN), none);
  assert.deepEqual(phonePushRelayMessage(undefined, ORIGIN), none);
  assert.deepEqual(phonePushRelayMessage({ [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: CREDENTIAL }, ""), none);
  assert.deepEqual(phonePushRelayMessage({ [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: "omb_install_short" }, ORIGIN), none);
  assert.deepEqual(phonePushRelayMessage({
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: CREDENTIAL,
    [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
  }, ORIGIN), none);
});

test("sends only changes, and everything again to a new server", () => {
  const sync = createPhonePushRelaySync();
  const sent = [];
  const post = (message) => {
    sent.push(message);
    return true;
  };
  const on = phonePushRelayMessage({ [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: CREDENTIAL }, ORIGIN);
  assert.equal(sync.sync(on, post), true);
  assert.equal(sync.sync(on, post), false);
  sync.reset();
  assert.equal(sync.sync(on, post), true);
  // no server: nothing recorded, so the next attempt sends
  assert.equal(sync.sync(phonePushRelayMessage({}, ORIGIN), () => false), false);
  assert.equal(sync.sync(phonePushRelayMessage({}, ORIGIN), post), true);
  assert.equal(sent.length, 3);
});

test("main's relay reads the current credentials and server at each call, and resends to a new server", () => {
  let credentials = {};
  let proc = null;
  const sent = [];
  const logged = [];
  const relay = createPhonePushRelay({
    controlPlane: () => ORIGIN,
    credentials: () => credentials,
    server: () => proc,
    log: (line) => logged.push(line),
  });
  relay.sync(); // no server yet: nothing sent, nothing recorded
  proc = { postMessage: (message) => sent.push(message) };
  credentials = { [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: CREDENTIAL };
  relay.sync();
  relay.sync();
  assert.deepEqual(sent, [{ type: PHONE_PUSH_RELAY_MESSAGE, access: { controlPlane: ORIGIN, credential: CREDENTIAL } }]);
  relay.serverStarted();
  assert.equal(sent.length, 2);
  proc = { postMessage: () => { throw new Error("channel closed"); } };
  credentials = {};
  relay.sync();
  assert.match(logged[0], /phone push relay sync failed: channel closed/);
});
