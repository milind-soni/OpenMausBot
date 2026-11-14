import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIslandKeyStore } from "./island-key-store.mjs";

const KEY = "omi_dev_fixture_A";
const SECOND = "omi_dev_fixture_B";
const crypt = value => Buffer.from(value).map(byte => byte ^ 0xa7);

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "island-key-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "profile", "omi.bin");
  const encryption = {
    available: async () => true,
    encrypt: async value => crypt(value),
    decrypt: async value => ({ shouldReEncrypt: false, result: crypt(value).toString() }),
  };
  return { root, file, encryption, store: createIslandKeyStore({ file, encryption }) };
}

test("the key is OS-encrypted in an atomic private file and never stored in plaintext", async t => {
  const h = await harness(t);
  assert.equal(await h.store.read(), null);
  await h.store.write(KEY);
  assert.equal(await h.store.read(), KEY);
  const bytes = await fs.readFile(h.file);
  assert.deepEqual(bytes, crypt(KEY));
  assert.equal(bytes.includes(KEY), false);
  assert.equal((await fs.stat(h.file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(h.file)), ["omi.bin"]);
  h.encryption.decrypt = async value => crypt(value).toString();
  assert.equal(await h.store.read(), KEY);
});

test("an unavailable keychain cannot create or replace a plaintext file", async t => {
  const h = await harness(t);
  h.encryption.available = async () => false;
  h.encryption.encrypt = () => assert.fail("must not encrypt with unavailable keychain");
  await assert.rejects(h.store.write(KEY), /Could not save/);
  assert.equal(await h.store.read(), null);
  assert.deepEqual(await fs.readdir(h.root), []);
});

test("disconnect deletes without requiring encryption, including after queued writes", async t => {
  const h = await harness(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.encryption.encrypt = async value => { await pending; return crypt(value); };
  const write = h.store.write(KEY);
  const clear = h.store.write(null);
  const read = h.store.read();
  release();
  await Promise.all([write, clear]);
  assert.equal(await read, null);
  h.encryption.available = async () => false;
  await h.store.write(null);
});

test("replacement is serialized and reads wait for the writes already queued", async t => {
  const h = await harness(t);
  const first = h.store.write(KEY);
  const second = h.store.write(SECOND);
  const read = h.store.read();
  await Promise.all([first, second]);
  assert.equal(await read, SECOND);
  assert.equal((await fs.stat(h.file)).mode & 0o777, 0o600);
});

test("encryption failure preserves the prior key and the queue recovers", async t => {
  const h = await harness(t);
  await h.store.write(KEY);
  h.encryption.encrypt = async () => { throw new Error(`private failure ${SECOND}`); };
  await assert.rejects(h.store.write(SECOND), error => {
    assert.equal(error.message.includes(SECOND), false);
    assert.equal(error.cause, undefined);
    return /Could not save/.test(error.message);
  });
  assert.equal(await h.store.read(), KEY);
  assert.deepEqual(await fs.readdir(path.dirname(h.file)), ["omi.bin"]);
  h.encryption.encrypt = async value => crypt(value);
  await h.store.write(SECOND);
  assert.equal(await h.store.read(), SECOND);
});

test("the store rejects symlinks, oversized records and invalid decrypted values", async t => {
  const h = await harness(t);
  await fs.mkdir(path.dirname(h.file));
  const other = path.join(h.root, "other.bin");
  await fs.writeFile(other, crypt(KEY));
  await fs.symlink(other, h.file);
  await assert.rejects(h.store.read(), /Could not read/);
  await h.store.write(null);
  assert.deepEqual(await fs.readFile(other), crypt(KEY));
  await fs.writeFile(h.file, Buffer.alloc(65 * 1024));
  await assert.rejects(h.store.read(), /Could not read/);
  await fs.writeFile(h.file, crypt("not-an-omi-key"));
  await assert.rejects(h.store.read(), /Could not read/);
});

test("invalid keys are rejected without disclosure, and no plaintext encryption fallback exists", async t => {
  const h = await harness(t);
  for (const key of ["omi_mcp_secret", "omi_dev_a\nb", "omi_dev_", {}, "omi_dev_" + "x".repeat(2049)]) {
    await assert.rejects(h.store.write(key), /Enter an Omi developer key/);
  }
  h.encryption.encrypt = async value => value;
  await assert.rejects(h.store.write(KEY), /Could not save/);
  assert.equal(await h.store.read(), null);
  assert.throws(() => createIslandKeyStore({ file: "relative", encryption: h.encryption }), /absolute/);
});
