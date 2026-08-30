import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyDockerPatchManifest } from "./docker-apply-patch.ts";

function manifest(root: string, value: unknown): string {
  const path = join(root, "manifest.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

describe("Docker patch applier", () => {
  it("writes only declared relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "docker-patch-"));
    const path = manifest(root, {
      root,
      writeScopes: ["src/**", "README.md"],
      changes: [
        { path: "src/value.txt", contents: "hello pilot\n" },
        { path: "README.md", contents: "ok\n" },
      ],
    });
    expect(applyDockerPatchManifest(path)).toEqual(["src/value.txt", "README.md"]);
    expect(readFileSync(join(root, "src/value.txt"), "utf8")).toBe("hello pilot\n");
  });

  it("rejects traversal, sensitive paths, out-of-scope writes, and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "docker-patch-deny-"));
    mkdirSync(join(root, "src"));
    symlinkSync(join(root, "outside"), join(root, "src", "link"));
    for (const path of ["../escape", ".env", ".git/config", "docs/outside.md", "src/link"]) {
      const file = manifest(root, { root, writeScopes: ["src/**"], changes: [{ path, contents: "x" }] });
      expect(() => applyDockerPatchManifest(file)).toThrow(/patch_/u);
    }
  });
});
