// Every secret the boot migration moves into credentials.bin must also be
// saved and cleared through credential:set, which edits that store. A secret
// saved only through PUT /api/config cannot be cleared: the next launch
// injects the stored copy again (workspace-credentials.mjs keeps the store
// authoritative over an empty config field).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CREDENTIAL_PATCH } from "./credential-patch.mjs";
import { WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";

const configRoutes = readFileSync(new URL("../server/routes/config.ts", import.meta.url), "utf8");

test("credential:set can save and clear every migrated workspace secret", () => {
  for (const { name, section, subsection, field } of WORKSPACE_CREDENTIALS) {
    assert.ok(Object.hasOwn(CREDENTIAL_PATCH, name), `${name} is missing from CREDENTIAL_PATCH`);
    for (const value of ["secret", ""]) {
      assert.deepEqual(CREDENTIAL_PATCH[name](value), { [section]: subsection ? { [subsection]: { [field]: value } } : { [field]: value } }, name);
    }
  }
});

test("the external secret save never leaves a migrated secret in config.json", () => {
  for (const { section, subsection, field } of WORKSPACE_CREDENTIALS) {
    const path = subsection ? `${section}?.${subsection}` : section;
    const write = subsection ? `${section}.${subsection}` : section;
    assert.ok(
      configRoutes.includes(`if (persisted.${path}?.${field} !== undefined) persisted.${write}.${field} = "";`),
      `${write}.${field} has no tombstone in the secretStorage=external save`,
    );
  }
});

test("a Qwen key carries only the destination the page showed, so the server can refuse a stale one", () => {
  const target = { region: "ap-southeast-1", workspace: "fixture-space" };
  assert.deepEqual(CREDENTIAL_PATCH.qwenLiveKey("secret", { qwenKeyTarget: { ...target, keyFor: "qwen:evil.invalid" }, everyClaudeBot: false }),
    { live: { qwen: { key: "secret" } }, qwenKeyTarget: target });
  assert.deepEqual(CREDENTIAL_PATCH.qwenLiveKey("", { qwenKeyTarget: target }), { live: { qwen: { key: "" } }, qwenKeyTarget: target });
  for (const options of [undefined, {}, { qwenKeyTarget: { region: "cn-beijing" } }, { qwenKeyTarget: { region: 1, workspace: "" } }, { live: { qwen: { keyFor: "qwen:evil.invalid" } } }]) {
    assert.deepEqual(CREDENTIAL_PATCH.qwenLiveKey("secret", options), { live: { qwen: { key: "secret" } } });
  }
});

test("a first Anthropic key leaves bots signed in to Claude on their sign-in, and only that option crosses", () => {
  assert.deepEqual(CREDENTIAL_PATCH.anthropicApiKey("secret", { everyClaudeBot: false }), { anthropic: { key: "secret", everyClaudeBot: false } });
  assert.deepEqual(CREDENTIAL_PATCH.anthropicApiKey("secret", { everyClaudeBot: true, url: "https://elsewhere.example.test" }), { anthropic: { key: "secret" } });
});
