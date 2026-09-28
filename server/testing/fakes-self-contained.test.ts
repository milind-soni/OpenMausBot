// The provider fakes in this folder run as bare subprocesses — spawned by
// the driver under test the way the real CLI would be — and at least one is
// copied OUT of the repo first: browser-codex-path.integration.test.ts strips
// the Codex fake to a plain .mjs in a temp bin dir and runs it as `codex`. A
// relative import from the repo has nothing to resolve to there; the fake
// dies at ESM link time and the driver reports "exited 1 before
// turn/completed", two files away from the line that caused it (#1372 did
// exactly this and main was red for a day). This pins the rule the fakes'
// own headers state: keep them dependency-free.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fakes a test copies out of the repo. Nothing relative at all may be
 * imported — not even a sibling in this folder. */
const COPIED_OUT = new Set(["fake-codex-app-server.ts"]);

/** Value imports only. `import type` is erased before the file runs, so a
 * type pulled from ../contracts.ts costs nothing at runtime. */
const importSpecifiers = (source: string): string[] =>
  [...source.matchAll(/^\s*import\s+(?!type\s)[^;]*?\sfrom\s+["']([^"']+)["']/gm), ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)]
    .map((match) => match[1]!);

describe("provider fakes stay self-contained", () => {
  // A subprocess fake announces itself with a node shebang; in-process
  // helpers (fake-driver.ts, fake-mcp-server.ts) are imported by tests and
  // may reach into the repo freely.
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
