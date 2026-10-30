import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUDFLARED_ASSETS, CLOUDFLARED_VERSION } from "../prepare-cloudflared.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const assets = Object.values(CLOUDFLARED_ASSETS);

describe("cloudflared pins have one source", () => {
  it("no workflow hard-codes a digest; they read scripts/prepare-cloudflared.mjs", () => {
    const dir = join(ROOT, ".github", "workflows");
    const pinned = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).flatMap((name) =>
      readFileSync(join(dir, name), "utf8").split("\n").filter((line) => !/^\s*-?\s*uses:/.test(line) && /\b[0-9a-f]{64}\b/.test(line)).map((line) => `${name}: ${line.trim()}`));
    expect(pinned).toEqual([]);
  });

  it("the third-party README lists the version and every asset's digests", () => {
    const readme = readFileSync(join(ROOT, "third_party", "cloudflared", "README.md"), "utf8");
    expect(readme).toContain(`\`cloudflared\` ${CLOUDFLARED_VERSION}`);
    for (const asset of assets) {
      const row = readme.split("\n").find((line) => line.includes(`\`${asset.name}\``));
      expect(row, asset.name).toBeDefined();
      expect(row).toContain(asset.sha256);
      if (asset.binarySha256 !== asset.sha256) expect(row).toContain(asset.binarySha256);
    }
  });
});
