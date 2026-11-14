// Comments do not record history git already holds: no pull request or issue
// numbers of this repo. An upstream issue keeps its owner/repo or its URL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const OUR_REF = /(?<![\w./-])(?:(?:PR|issue|pull request)\s+)?#\d{3,5}\b/i;

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "server", "shared", "src", "scripts", "evals", "electron", "companion", "cloudflare"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx|mts|mjs|cjs|js)$/.test(file) && !file.startsWith("electron/vendor/") && !file.endsWith(".d.ts"));
}

function commentLines(text: string): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlock || trimmed.startsWith("//") || trimmed.startsWith("/*")) found.push([index + 1, trimmed]);
    if (inBlock) inBlock = !trimmed.includes("*/");
    else if (trimmed.startsWith("/*")) inBlock = !trimmed.includes("*/");
  });
  return found;
}

describe("comments", () => {
  it("name no pull request or issue of this repo", () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      for (const [line, text] of commentLines(readFileSync(new URL(file, ROOT), "utf8"))) {
        if (OUR_REF.test(text)) found.push(`${file}:${line}: ${text}`);
      }
    }
    expect(found, "History belongs in git, not in a comment (AGENTS.md, Comments)").toEqual([]);
  });
});
