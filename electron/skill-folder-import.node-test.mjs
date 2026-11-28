import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readChosenSkillFolder } from "./skill-folder-import.mjs";
import { SKILL_FOLDER_LIMITS } from "./skill-folder-plan.mjs";

test("reads the chosen skill's files within the folder limits and skips links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omb-skill-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, "pdf-forms");
  const outside = join(root, "private.txt");
  const script = join(skill, "scripts/run");
  const asset = Buffer.from([0, 255, 128]);
  await mkdir(join(skill, "assets"), { recursive: true });
  await mkdir(join(skill, "scripts"));
  await mkdir(join(skill, ".git"));
  await writeFile(join(skill, "SKILL.md"), "skill contents");
  await writeFile(join(skill, "assets/form.bin"), asset);
  await writeFile(script, "script contents");
  await chmod(script, 0o700);
  await writeFile(join(skill, ".git/config"), "git metadata");
  await writeFile(join(skill, "large.bin"), "");
  await truncate(join(skill, "large.bin"), SKILL_FOLDER_LIMITS.fileBytes + 1);
  await writeFile(outside, "private contents");
  await link(outside, join(skill, "hardlink.txt"));
  await symlink(root, join(skill, "outside"), "junction");

  const result = await readChosenSkillFolder(skill);
  assert.deepEqual(result.files.map(({ path }) => path), ["SKILL.md", "assets/form.bin", "scripts/run"]);
  assert.deepEqual(Buffer.from(result.files[1].base64, "base64"), asset);
  if (process.platform !== "win32") assert.equal(result.files[2].executable, true);
  assert.deepEqual(result.skipped, [
    { path: ".git/", reason: "hidden" },
    { path: "hardlink.txt", reason: "link" },
    { path: "large.bin", reason: "large" },
    { path: "outside", reason: "link" },
  ]);
  assert.equal(result.skippedCount, 4);
  assert.deepEqual(await readChosenSkillFolder(root), { error: "Choose a folder containing SKILL.md." });
});
