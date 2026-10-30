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
  for (const { name, section, field } of WORKSPACE_CREDENTIALS) {
    assert.ok(Object.hasOwn(CREDENTIAL_PATCH, name), `${name} is missing from CREDENTIAL_PATCH`);
    for (const value of ["secret", ""]) assert.deepEqual(CREDENTIAL_PATCH[name](value), { [section]: { [field]: value } }, name);
  }
});

test("the external secret save never leaves a migrated secret in config.json", () => {
  for (const { section, field } of WORKSPACE_CREDENTIALS) {
    assert.ok(
      configRoutes.includes(`if (persisted.${section}?.${field} !== undefined) persisted.${section}.${field} = "";`),
      `${section}.${field} has no tombstone in the secretStorage=external save`,
    );
  }
});
