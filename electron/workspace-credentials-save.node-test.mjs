// Every secret the boot migration moves into credentials.bin must also be
// saved and cleared through credential:set, which edits that store. A secret
// saved only through PUT /api/config cannot be cleared: the next launch
// injects the stored copy again (workspace-credentials.mjs keeps the store
// authoritative over an empty config field).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("credential:set can save and clear every migrated workspace secret", () => {
  const start = main.indexOf("const CREDENTIAL_PATCH = {");
  const end = main.indexOf("};", start);
  assert.ok(start >= 0 && end > start, "CREDENTIAL_PATCH not found in main.mjs");
  const patch = main.slice(start, end);
  for (const { name, section, field } of WORKSPACE_CREDENTIALS) {
    assert.match(patch, new RegExp(`\\b${name}: \\(value\\) => \\(\\{ ${section}: \\{ ${field}: value \\} \\}\\)`), `${name} is missing from CREDENTIAL_PATCH`);
  }
});

test("the external secret save never leaves a migrated secret in config.json", () => {
  for (const { section, field } of WORKSPACE_CREDENTIALS) {
    assert.ok(
      server.includes(`if (persisted.${section}?.${field} !== undefined) persisted.${section}.${field} = "";`),
      `${section}.${field} has no tombstone in the secretStorage=external save`,
    );
  }
});
