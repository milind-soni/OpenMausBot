import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { portableSkillFilesFromMemory, readPortableSkillFiles } from "./portable-skill-files.ts";

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), "omb-portable-skill-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reads only safe bounded Markdown and reports omitted files and links", () => {
  const root = makeRoot();
  mkdirSync(join(root, "references", "nested"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "instructions");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "references", "nested", "guide.md"), "guide");
  writeFileSync(join(root, "run.sh"), "not shared");
  writeFileSync(join(root, "bad.md"), Buffer.from([0xff]));
  writeFileSync(join(root, "big.md"), "x".repeat(65537));
  if (process.platform !== "win32") {
    symlinkSync(join(root, "README.md"), join(root, "link.md"));
    symlinkSync(join(root, "references"), join(root, "linked-folder"));
    writeFileSync(join(root, "original.txt"), "not a reference");
    linkSync(join(root, "original.txt"), join(root, "hard.md"));
  }
  const result = readPortableSkillFiles(root)!;
  expect(result.files).toEqual([{ path: "README.md", content: "read me" }, { path: "references/nested/guide.md", content: "guide" }]);
  expect(result.skipped).toEqual(expect.arrayContaining([
    { path: "run.sh", reason: "skill_file_type" }, { path: "bad.md", reason: "skill_file_type" },
    { path: "big.md", reason: "skill_file_limit" },
    ...(process.platform === "win32" ? [] : [{ path: "link.md", reason: "skill_file_unsafe" }, { path: "linked-folder", reason: "skill_file_unsafe" }, { path: "hard.md", reason: "skill_file_unsafe" }]),
  ]));
});

it("caps file counts and refuses traversal and collisions for fetched defaults", () => {
  const result = portableSkillFilesFromMemory([
    { path: "../outside.md", content: "secret" }, { path: "A.md", content: "a" }, { path: "a.md", content: "b" },
    ...Array.from({ length: 35 }, (_, i) => ({ path: `ref-${i}.md`, content: "x" })),
  ]);
  expect(result.files).toHaveLength(32);
  expect(result.skipped).toEqual(expect.arrayContaining([
    { path: "../outside.md", reason: "skill_file_unsafe" }, { path: "a.md", reason: "skill_file_limit" },
  ]));
});

it("reports invalid UTF-8 text from memory as a file type omission", () => {
  expect(portableSkillFilesFromMemory([{ path: "guide.md", content: "\ud800" }])).toEqual({
    files: [], skipped: [{ path: "guide.md", reason: "skill_file_type" }],
  });
});
