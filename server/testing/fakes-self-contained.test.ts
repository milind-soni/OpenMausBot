// Subprocess fakes run as bare node children, and a test copies the Codex fake out of the repo (to a temp
// bin dir as `codex`), where any relative import dies at ESM link time.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fakes a test copies out of the repo: nothing relative may be imported, not even a sibling. */
const COPIED_OUT = new Set(["fake-codex-app-server.ts", "fake-acp-cli.ts"]);

/** Value imports only: `import type` is erased before the file runs. */
const importSpecifiers = (source: string): string[] =>
  [...source.matchAll(/^\s*import\s+(?!type\s)[^;]*?\sfrom\s+["']([^"']+)["']/gm), ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)]
    .map((match) => match[1]!);

describe("provider fakes stay self-contained", () => {
  // A subprocess fake starts with a node shebang; in-process helpers may import from the repo.
  const fakes = readdirSync(HERE).filter((file) =>
    /^fake-.*\.ts$/.test(file) && !file.endsWith(".test.ts") && readFileSync(join(HERE, file), "utf8").startsWith("#!"),
  );

  it("sees the fakes this guard exists for", () => {
    expect(fakes).toContain("fake-codex-app-server.ts");
    expect(fakes).toContain("fake-claude-cli.ts");
    expect(fakes).toContain("fake-acp-cli.ts");
  });

  it.each(fakes)("%s imports nothing from outside server/testing", (file) => {
    const specifiers = importSpecifiers(readFileSync(join(HERE, file), "utf8"));
    const outside = specifiers.filter((specifier) => specifier.startsWith("../"));
    expect(
      outside,
      `${file} imports ${outside.join(", ")} from outside server/testing. Fakes run as bare node subprocesses, some copied out of the repo; inline the helper instead.`,
    ).toEqual([]);
    if (COPIED_OUT.has(file)) {
      const relative = specifiers.filter((specifier) => specifier.startsWith("./"));
      expect(
        relative,
        `${file} is copied out of the repo by a test and may import nothing relative, but imports ${relative.join(", ")}.`,
      ).toEqual([]);
    }
  });
});
