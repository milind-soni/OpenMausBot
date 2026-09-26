import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSttSettings } from "./stt-settings.mjs";
import { publicConfig } from "./stt-core.mjs";
import { openWindowsVoiceTyping } from "./stt-windows.mjs";

const storage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(value).reverse(),
  decryptStringAsync: async value => ({ result: Buffer.from(value).reverse().toString() }),
};
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omb-stt-settings-test-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test("OpenRouter selection and key survive a new settings instance and blank-key save", () => fixture(async root => {
  const first = createSttSettings(root, storage, "win32");
  const saved = await first.save({ provider: "openrouter", profiles: { openrouter: { key: "synthetic-secret" } } });
  assert.equal(publicConfig(saved).profiles.openrouter.hasKey, true);
  assert(!JSON.stringify(publicConfig(saved)).includes("synthetic-secret"));
  const second = createSttSettings(root, storage, "win32");
  assert.equal((await second.load()).provider, "openrouter");
  await second.save(publicConfig(await second.load()));
  const third = await createSttSettings(root, storage, "win32").load();
  assert.equal(third.provider, "openrouter");
  assert.equal(third.profiles.openrouter.key, "synthetic-secret");
}));
test("unlock failure never falls back to Windows defaults or overwrites the key", () => fixture(async root => {
  await createSttSettings(root, storage, "win32").save({ provider: "openrouter", profiles: { openrouter: { key: "retained" } } });
  const before = await fs.readFile(path.join(root, "settings.enc"));
  const locked = createSttSettings(root, { ...storage, decryptStringAsync: async () => { throw new Error("locked"); } }, "win32");
  await assert.rejects(locked.load(), /unlocked/);
  await assert.rejects(locked.save({ provider: "windows-typing" }), /unlocked/);
  assert.deepEqual(await fs.readFile(path.join(root, "settings.enc")), before);
}));
test("failed encryption preserves disk and in-memory provider, then permits retry", () => fixture(async root => {
  let fail = false;
  const store = createSttSettings(root, { ...storage, encryptStringAsync: async value => {
    if (fail) throw new Error("synthetic storage failure");
    return storage.encryptStringAsync(value);
  } }, "win32");
  await store.save({ provider: "openrouter", profiles: { openrouter: { key: "retained" } } });
  fail = true;
  await assert.rejects(store.save({ provider: "groq" }), /storage failure/);
  assert.equal((await store.load()).provider, "openrouter");
  assert.equal((await createSttSettings(root, storage, "win32").load()).provider, "openrouter");
  fail = false;
  await store.save({ provider: "groq" });
  assert.equal((await store.load()).provider, "groq");
}));
test("queued saves merge keys and explicit removal persists", () => fixture(async root => {
  const store = createSttSettings(root, storage, "win32");
  await Promise.all([store.save({ profiles: { openrouter: { key: "first" } } }), store.save({ profiles: { groq: { key: "second" } } })]);
  const loaded = await store.load();
  assert.equal(loaded.profiles.openrouter.key, "first"); assert.equal(loaded.profiles.groq.key, "second");
  await store.save({ profiles: { openrouter: { clearKey: true } } });
  assert.equal((await createSttSettings(root, storage, "win32").load()).profiles.openrouter.key, "");
}));
test("unprotected systems may save keyless settings but reject credentials", () => fixture(async root => {
  const insecure = { ...storage, isAsyncEncryptionAvailable: async () => false };
  const store = createSttSettings(root, insecure, "win32");
  await store.save({ provider: "windows-typing" });
  await assert.rejects(store.save({ profiles: { openrouter: { key: "private" } } }), /Protected credential storage/);
  assert(!(await fs.readFile(path.join(root, "settings.json"), "utf8")).includes("private"));
}));
test("Windows shortcut uses fixed argument-array invocation and refuses other platforms", async () => {
  const calls = [];
  await openWindowsVoiceTyping({ platform: "win32", run: async (...args) => calls.push(args) });
  assert.equal(calls[0][0], "powershell.exe"); assert(calls[0][1].includes("-NonInteractive"));
  await assert.rejects(openWindowsVoiceTyping({ platform: "darwin", run: async () => assert.fail("must not execute") }), /unavailable/);
});
