import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("boots cloud secrets before loading any other server module", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source.match(/^import[^;]+;/)?.[0]).toBe('import { BOOT_CLOUD_SECRETS } from "./cloud-secrets-boot.ts";');
});
