// Pure, synthetic fixtures: no Electron runtime, keychain or user files.
import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_CREDENTIALS, migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { CREDENTIAL_ENV_NAMES, redactSecretsInLine } from "./diagnostics.mjs";

test("retired Deepgram credentials are not migrated or emitted as live env", () => {
  assert.equal(WORKSPACE_CREDENTIALS.some((row) => row.section === "dictation" || row.name === "dictationApiKey" || row.env === "ASTRA_DICTATION_KEY"), false);
  const config = { dictation: { key: "fixture-legacy-file" }, wakeWord: { accessKey: "fixture-wake" }, tts: { key: "fixture-tts", provider: "system" } };
  const credentials = { dictationApiKey: "fixture-legacy-store", composioApiKey: "fixture-composio" };
  const result = migrateWorkspaceCredentials(config, credentials);
  assert.deepEqual(result.config, { dictation: config.dictation, wakeWord: {}, tts: { provider: "system" } });
  assert.deepEqual(result.credentials, { ...credentials, picovoiceAccessKey: "fixture-wake", ttsKey: "fixture-tts" });
  assert.deepEqual(workspaceCredentialEnv(result.credentials), { ASTRA_TTS_KEY: "fixture-tts", ASTRA_PICOVOICE_KEY: "fixture-wake" });
  assert.deepEqual(workspaceCredentialEnv(credentials), {});
  assert.equal(config.wakeWord.accessKey, "fixture-wake");
  assert.equal(credentials.dictationApiKey, "fixture-legacy-store");
  const again = migrateWorkspaceCredentials(result.config, result.credentials);
  assert.equal(again.configChanged, false);
  assert.equal(again.credentialsChanged, false);
});

test("the generic encrypted-store reader preserves legacy and unrelated entries", async () => {
  const credentials = { dictationApiKey: "fixture-legacy-store", composioApiKey: "fixture-composio", picovoiceAccessKey: "fixture-wake" };
  const result = await readSecureCredentials({
    exists: () => true,
    isAvailable: async () => true,
    readFile: () => Buffer.from("synthetic ciphertext"),
    decrypt: async () => JSON.stringify(credentials),
    sleep: async () => assert.fail("unexpected retry"),
  });
  assert.deepEqual(result, { status: "ok", credentials });
  assert.deepEqual(workspaceCredentialEnv(result.credentials), { ASTRA_PICOVOICE_KEY: "fixture-wake" });
});

test("legacy Deepgram env and stored-key log forms remain redacted", () => {
  assert.ok(CREDENTIAL_ENV_NAMES.includes("ASTRA_DICTATION_KEY"));
  for (const line of [
    "ASTRA_DICTATION_KEY=fixture-legacy-secret",
    '{"ASTRA_DICTATION_KEY":"fixture-legacy-secret"}',
    '{"dictationApiKey":"fixture-legacy-secret"}',
  ]) {
    const redacted = redactSecretsInLine(line);
    assert.ok(!redacted.includes("fixture-legacy-secret"));
    assert.match(redacted, /redacted/);
  }
});
