// While the page holds a relay pairing (a phone browser away from home), its own server is reachable only through
// MausBot Relay, so every request the app makes goes through serverFetch (src/lib/relay-server.ts), which keeps any
// path outside /api a plain fetch. A bare fetch( in app code is a screen that breaks away from home.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);

/** App code: not tests, the relay itself, test rigs, or the preview pages that stand in a fake server for fetch. */
function appFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.|\.e2e\./.test(file) && !file.startsWith("src/testing/") && !file.startsWith("src/lib/e2e/"))
    .filter((file) => file !== "src/lib/relay-server.ts" && !file.endsWith("-preview.tsx"));
}

describe("app requests to its own server", () => {
  it("all go through serverFetch, never a bare fetch", () => {
    const bare: string[] = [];
    for (const file of appFiles()) {
      readFileSync(new URL(file, ROOT), "utf8").split("\n").forEach((line, index) => {
        if (/(?<![\w$.])fetch\(/.test(line.replace(/\/\/.*$/, ""))) bare.push(`${file}:${index + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });
});
