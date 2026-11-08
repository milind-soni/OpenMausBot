import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

it("binds the release to file paths, decoded bytes and executable metadata, while keeping old stamps", () => {
  const hash = (files: Parameters<typeof skillReleaseValue>[0]["files"]) => partHash(skillReleaseValue({ instructions, files }));
  expect(hash(undefined)).toBe(partHash(instructions));
  const binary = hash([{ path: "assets/a.bin", binary: { base64: "AP8=" } }]);
  expect(binary).not.toBe(hash([{ path: "assets/b.bin", binary: { base64: "AP8=" } }]));
  expect(binary).not.toBe(hash([{ path: "assets/a.bin", binary: { base64: "AAE=" } }]));
  expect(hash([{ path: "scripts/a.sh", content: "echo fixture" }])).not.toBe(
    hash([{ path: "scripts/a.sh", content: "echo fixture", executable: true }]),
  );
});

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

it("retries a failed cleanup of an intact quarantined skill using its durable receipt", () => {
  const { skill, retired, state } = fixture();
  const failed = retireUnchangedSkillRoot(skill, retired, state, { remove: () => { throw new Error("disk unavailable"); } });
  expect(failed).toHaveProperty("error", expect.stringContaining("still needs cleanup"));
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  expect(names).toHaveLength(2);
  const receipt = JSON.parse(readFileSync(join(quarantine, names.find((name) => name.endsWith(".json"))!), "utf8"));
  expect(receipt).toEqual({ directory: skill, identity: retired.identity, hash: retired.hash });
  expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
  expect(readdirSync(quarantine)).toEqual([]);
});

it("retains a partially deleted quarantine and truthfully refuses to retry destructive cleanup", () => {
  const { skill, retired, state } = fixture();
  const failure = retireUnchangedSkillRoot(skill, retired, state, { remove: (directory) => {
    rmSync(join(String(directory), "references", "guide.md"));
    throw new Error("partial deletion");
  } });
  expect(failure).toHaveProperty("error", expect.stringContaining("still needs cleanup"));
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  const held = join(quarantine, names.find((name) => !name.endsWith(".json"))!);
  writeFileSync(join(held, "new-local-data.txt"), "Preserve this");
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error", expect.stringContaining(quarantine));
  expect(readFileSync(join(held, "new-local-data.txt"), "utf8")).toBe("Preserve this");
  expect(readdirSync(quarantine)).toHaveLength(2);
});

it("detects an older randomly named quarantine instead of claiming retirement succeeded", () => {
  const { skill, retired, state } = fixture();
  const quarantine = join(state, "retired-roots"); mkdirSync(quarantine);
  renameSync(skill, join(quarantine, "legacy-random-name"));
  rmSync(join(quarantine, "legacy-random-name", "references", "guide.md"));
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error", expect.stringContaining(quarantine));
  expect(existsSync(join(quarantine, "legacy-random-name", "SKILL.md"))).toBe(true);
});

it.skipIf(process.platform === "win32")("does not follow a substituted recovery receipt", () => {
  const { root, skill, retired, state } = fixture();
  retireUnchangedSkillRoot(skill, retired, state, { remove: () => { throw new Error("unavailable"); } });
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  const marker = join(quarantine, names.find((name) => name.endsWith(".json"))!);
  const outside = join(root, "outside"); writeFileSync(outside, "leave alone");
  rmSync(marker); symlinkSync(outside, marker);
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error");
  expect(readFileSync(outside, "utf8")).toBe("leave alone");
  expect(existsSync(join(quarantine, names.find((name) => !name.endsWith(".json"))!, "SKILL.md"))).toBe(true);
});
