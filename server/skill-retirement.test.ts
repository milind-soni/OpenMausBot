import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { retireUnchangedSkillRoot, skillRootIdentity } from "./skill-retirement.ts";

const homes: string[] = [];
const instructions = "---\nname: runbook\ndescription: Fixture\n---\nGuide.\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-retired-skill-")); homes.push(root);
  const state = join(root, "state"); mkdirSync(state);
  const skill = join(root, "runbook"); mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), instructions);
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  const retired = { identity: skillRootIdentity(skill)!, hash: partHash(skillReleaseValue({ instructions, files: [{ path: "references/guide.md", content: "Guide.\n" }] })) };
  return { root, skill, retired, state };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("retires only the unchanged directory belonging to the previous skill", () => {
  const { root, skill, retired, state } = fixture();
  writeFileSync(join(root, "keep.txt"), "Keep");
  expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
  expect(existsSync(skill)).toBe(false);
  expect(existsSync(join(root, "keep.txt"))).toBe(true);
});

it("keeps a directory with a locally edited companion", () => {
  const { skill, retired, state } = fixture();
  writeFileSync(join(skill, "references", "guide.md"), "My edit.\n");
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error");
  expect(existsSync(join(skill, "references", "guide.md"))).toBe(true);
});

it.skipIf(process.platform === "win32")("refuses a replacement symlink without following it", () => {
  const { root, skill, retired, state } = fixture();
  renameSync(skill, join(root, "original"));
  const other = join(root, "other"); mkdirSync(other); writeFileSync(join(other, "keep.txt"), "Keep");
  symlinkSync(other, skill);
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error");
  expect(existsSync(join(other, "keep.txt"))).toBe(true);
  const parentLink = join(root, "linked-parent"); symlinkSync(other, parentLink);
  expect(retireUnchangedSkillRoot(join(parentLink, "absent"), retired, state)).toHaveProperty("error");
});

it.skipIf(process.platform === "win32")("does not delete an outside folder swapped in just before cleanup", () => {
  const { root, skill, retired, state } = fixture();
  const other = join(root, "other"); mkdirSync(other); writeFileSync(join(other, "keep.txt"), "Keep");
  const original = join(root, "original");
  const result = retireUnchangedSkillRoot(skill, retired, state, { beforeMove: () => { renameSync(skill, original); symlinkSync(other, skill); } });
  expect(result).toHaveProperty("error");
  expect(existsSync(join(other, "keep.txt"))).toBe(true);
  expect(existsSync(join(original, "references", "guide.md"))).toBe(true);
});
