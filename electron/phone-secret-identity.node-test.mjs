import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHONE_SECRET_CREDENTIAL_KEY,
  createPhoneSecretIdentity,
  createPhoneSecretSaveCoordinator,
  decodePhoneSecretSaveRequest,
  phoneSecretKeyId,
  phoneSecretPrivateKeyMessage,
  phoneSecretSaveResult,
  readPhoneSecretIdentity,
  withPhoneSecretIdentity,
} from "./phone-secret-identity.mjs";

test("creates and validates one P-256 phone credential identity", async () => {
  const identity = await createPhoneSecretIdentity();
  assert.equal(identity.version, 1);
  assert.equal(Buffer.from(identity.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(identity.privateKey.d, "base64url").length, 32);
  assert.equal(phoneSecretKeyId(identity.publicKey), identity.keyId);
  assert.deepEqual(
    readPhoneSecretIdentity({ [PHONE_SECRET_CREDENTIAL_KEY]: identity }),
    identity,
  );
});

test("rejects a mismatched or malformed stored identity", async () => {
  const identity = await createPhoneSecretIdentity();
  assert.equal(readPhoneSecretIdentity({
    [PHONE_SECRET_CREDENTIAL_KEY]: { ...identity, keyId: "AAAAAAAAAAAAAAAAAAAAAA" },
  }), null);
  assert.equal(readPhoneSecretIdentity({
    [PHONE_SECRET_CREDENTIAL_KEY]: {
      ...identity,
      privateKey: { ...identity.privateKey, d: "not-base64" },
    },
  }), null);
  const other = await createPhoneSecretIdentity();
  assert.equal(readPhoneSecretIdentity({
    [PHONE_SECRET_CREDENTIAL_KEY]: {
      ...identity,
      privateKey: { ...identity.privateKey, d: other.privateKey.d },
    },
  }), null);
});

test("adds the identity without changing other secure credentials", async () => {
  const identity = await createPhoneSecretIdentity();
  const next = withPhoneSecretIdentity({ xaiApiKey: "kept" }, identity);
  assert.equal(next.xaiApiKey, "kept");
  assert.deepEqual(next[PHONE_SECRET_CREDENTIAL_KEY], identity);
});

test("private key messages never contain the public pairing URL shape", async () => {
  const identity = await createPhoneSecretIdentity();
  assert.deepEqual(phoneSecretPrivateKeyMessage(identity), {
    type: "openmausbot:phone-secret-key",
    version: 1,
    keyId: identity.keyId,
    privateKey: identity.privateKey,
  });
});

test("accepts only bounded private save requests", () => {
  assert.deepEqual(decodePhoneSecretSaveRequest({
    type: "openmausbot:phone-secret-save",
    requestId: "request_1",
    target: "xaiApiKey",
    value: "  secret  ",
  }), { requestId: "request_1", target: "xaiApiKey", value: "secret" });
  assert.equal(decodePhoneSecretSaveRequest({
    type: "openmausbot:phone-secret-save",
    requestId: "request_1",
    target: "xaiApiKey",
    value: " ",
  }), null);
  assert.equal(decodePhoneSecretSaveRequest({
    type: "openmausbot:phone-secret-save",
    requestId: "request_1",
    target: "xaiApiKey",
    value: "x".repeat(4_097),
  }), null);
  assert.equal(decodePhoneSecretSaveRequest({
    type: "openmausbot:phone-secret-save",
    requestId: 123,
    target: "xaiApiKey",
    value: "secret",
  }), null);
});

test("save results expose only a bounded error", () => {
  assert.deepEqual(phoneSecretSaveResult("request_1", true), {
    type: "openmausbot:phone-secret-save-result",
    requestId: "request_1",
    ok: true,
  });
  assert.equal(phoneSecretSaveResult("request_1", false, "x".repeat(400)).error.length, 180);
});

test("joins and caches an exact private save retry", async () => {
  let calls = 0;
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const save = createPhoneSecretSaveCoordinator(async () => {
    calls += 1;
    await blocked;
  });
  const request = { requestId: "operation_1", target: "xaiApiKey", value: "secret" };

  const first = save(request);
  const concurrentRetry = save(request);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await first, phoneSecretSaveResult("operation_1", true));
  assert.deepEqual(await concurrentRetry, phoneSecretSaveResult("operation_1", true));
  assert.deepEqual(await save(request), phoneSecretSaveResult("operation_1", true));
  assert.equal(calls, 1);
});

test("rejects reuse of a completed operation id for another credential target", async () => {
  let calls = 0;
  const save = createPhoneSecretSaveCoordinator(async () => { calls += 1; });
  const first = { requestId: "operation_1", target: "xaiApiKey", value: "secret" };
  assert.equal((await save(first)).ok, true);
  const mismatch = await save({ ...first, target: "ttsKey", value: "different" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /did not match/i);
  assert.equal(calls, 1);
});

test("rejects a mismatched plaintext while an operation is active", async () => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const save = createPhoneSecretSaveCoordinator(async () => { await blocked; });
  const first = { requestId: "operation_1", target: "xaiApiKey", value: "secret" };
  const pending = save(first);

  const mismatch = await save({ ...first, value: "different" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /did not match/i);
  finish();
  assert.equal((await pending).ok, true);
});

test("does not cache a failed save for an exact encrypted retry", async () => {
  let calls = 0;
  const save = createPhoneSecretSaveCoordinator(async () => {
    calls += 1;
    if (calls === 1) throw new Error("credential store was temporarily locked");
  });
  const request = { requestId: "operation_1", target: "xaiApiKey", value: "secret" };

  const [failed, concurrentWaiter] = await Promise.all([save(request), save(request)]);
  for (const result of [failed, concurrentWaiter]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /temporarily locked/i);
  }
  assert.equal(calls, 1);
  assert.deepEqual(await save(request), phoneSecretSaveResult("operation_1", true));
  assert.equal(calls, 2);
});
