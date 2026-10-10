// The local-origin gate is bound with a `const` destructure while ipcMain
// handlers are registered at module top level. If that binding ever sits
// below the first `localOnly(...)` again (it did once, #802), the packaged app
// dies at boot with "Cannot access 'localOnly' before initialization" — which
// only the Linux package smoke sees, long after the unit legs are green. This
// pins the order statically so the failure is a red test, not a red release.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8").split("\n");
const code = (line) => !/^\s*(?:\/\/|\/?\*)/.test(line);
const declaration = main.findIndex((line) => /^const \{[^}]*\blocalOnly\b[^}]*\} = localOriginModule;/.test(line));
const firstUse = main.findIndex((line) => code(line) && /\blocalOnly(?:Sync)?\(/.test(line) && !line.startsWith("const {"));

test("localOnly is bound before the first top-level handler that calls it", () => {
  assert.ok(declaration >= 0, "the local-origin destructure is missing from main.mjs");
  assert.ok(firstUse >= 0, "no top-level localOnly(...) use found");
  assert.ok(
    declaration < firstUse,
    `localOnly is bound on line ${declaration + 1} but first called on line ${firstUse + 1}: the packaged app will crash at boot`,
  );
});
