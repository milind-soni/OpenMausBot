import { chmodSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { portableFilesForDisk, portableSkillFilesFromMemory, readPortableSkillFiles, selectPortableFiles, snapshotPortableSkill } from "./portable-skill-files.ts";
import { skillFolderDigest } from "./skill-folder.ts";

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), "omb-portable-skill-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reads bounded text, scripts and binary assets, and reports private files and links", () => {
  const root = makeRoot();
  mkdirSync(join(root, "references", "nested"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "instructions");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "references", "nested", "guide.md"), "guide");
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho fixture\n");
  if (process.platform !== "win32") chmodSync(join(root, "run.sh"), 0o700);
  writeFileSync(join(root, "bad.md"), Buffer.from([0xff]));
  writeFileSync(join(root, "big.md"), "x".repeat(512 * 1024 + 1));
  writeFileSync(join(root, "auth.json"), "private fixture");
  if (process.platform !== "win32") {
    writeFileSync(join(root, "executable.bin"), Buffer.from([0, 255]));
    chmodSync(join(root, "executable.bin"), 0o700);
    symlinkSync(join(root, "README.md"), join(root, "link.md"));
    symlinkSync(join(root, "references"), join(root, "linked-folder"));
    writeFileSync(join(root, "original.txt"), "not a reference");
    linkSync(join(root, "original.txt"), join(root, "hard.md"));
  }
  const result = readPortableSkillFiles(root)!;
  expect(result.files).toEqual(expect.arrayContaining([
    { path: "README.md", content: "read me" }, { path: "references/nested/guide.md", content: "guide" },
    { path: "bad.md", binary: { base64: "/w==" } },
    { path: "run.sh", content: "#!/bin/sh\necho fixture\n", ...(process.platform === "win32" ? {} : { executable: true }) },
  ]));
  expect(result.files.map((file) => file.path)).not.toContain("auth.json");
  expect(selectPortableFiles(result.files, false).skipped).toEqual([{ path: "bad.md", reason: "skill_file_binary" }]);
  expect(selectPortableFiles(result.files, true).files).toEqual(result.files);
  expect(result.skipped).toEqual(expect.arrayContaining([
    { path: "auth.json", reason: "skill_file_unsafe" }, { path: "big.md", reason: "skill_file_limit" },
    ...(process.platform === "win32" ? [] : [{ path: "link.md", reason: "skill_file_unsafe" }, { path: "linked-folder", reason: "skill_file_unsafe" },
      { path: "hard.md", reason: "skill_file_unsafe" }, { path: "executable.bin", reason: "skill_file_type" }]),
  ]));
});

it("caps file counts and refuses traversal and collisions for fetched defaults", () => {
  const result = portableSkillFilesFromMemory([
    { path: "../outside.md", content: "secret" }, { path: "A.md", content: "a" }, { path: "a.md", content: "b" },
    ...Array.from({ length: 130 }, (_, i) => ({ path: `ref-${i}.md`, content: "x" })),
  ]);
  expect(result.files).toHaveLength(128);
  expect(result.skipped).toEqual(expect.arrayContaining([
    { path: "../outside.md", reason: "skill_file_unsafe" }, { path: "a.md", reason: "skill_file_limit" },
  ]));
});

it("accepts the largest schema-valid tree with distinct deep directories", () => {
  const root = makeRoot();
  writeFileSync(join(root, "SKILL.md"), "instructions");
  for (let index = 0; index < 128; index++) {
    const directory = join(root, `dir-${index}`, "a", "b", "c", "d", "e", "f");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "guide.txt"), "fixture");
  }
  const result = readPortableSkillFiles(root);
  expect(result?.files).toHaveLength(128);
  expect(result?.skipped).toEqual([]);
});

it("binds the captured bytes to review even if the disk is restored before verification", () => {
  const root = makeRoot(), guide = join(root, "guide.md"), paths = ["guide.md", "auth.json"];
  writeFileSync(join(root, "SKILL.md"), "instructions");
  writeFileSync(guide, "reviewed"); writeFileSync(join(root, "auth.json"), "private fixture");
  const expected = skillFolderDigest(root, paths, { remember: false });
  const verify = (files: Parameters<typeof portableFilesForDisk>[0]) => skillFolderDigest(root, paths,
    { captured: portableFilesForDisk(files), remember: false }) === expected;
  const intact = snapshotPortableSkill(root, () => "instructions", paths, verify);
  expect(intact?.files).toEqual([{ path: "guide.md", content: "reviewed" }]);
  expect(intact?.skipped).toContainEqual({ path: "auth.json", reason: "skill_file_unsafe" });
  writeFileSync(guide, "unreviewed");
  const raced = snapshotPortableSkill(root, () => "instructions", paths, (files) => {
    writeFileSync(guide, "reviewed");
    return verify(files);
  });
  expect(raced).toBeNull();
});

it("reports invalid UTF-8 text from memory as a file type omission", () => {
  expect(portableSkillFilesFromMemory([{ path: "guide.md", content: "\ud800" }])).toEqual({
    files: [], skipped: [{ path: "guide.md", reason: "skill_file_type" }],
  });
});

it("does not read added files outside the reviewed path list", () => {
  const root = makeRoot();
  writeFileSync(join(root, "reviewed.md"), "reviewed");
  writeFileSync(join(root, "added.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(readPortableSkillFiles(root, ["reviewed.md"])).toEqual({
    files: [{ path: "reviewed.md", content: "reviewed" }],
    skipped: [{ path: "added.bin", reason: "skill_file_unreviewed" }],
  });
});
