import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the OAuth client secret env-only in operator-facing usage", () => {
  const source = readFileSync(join(import.meta.dirname, "openconnector-oauth.ts"), "utf8");
  expect(source).toContain("OPENCONNECTOR_OAUTH_CLIENT_SECRET");
  expect(source).not.toContain("--client-secret");
});
