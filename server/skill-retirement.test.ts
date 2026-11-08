import { closeSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { retireUnchangedSkillRoot, skillRootIdentity } from "./skill-retirement.ts";
import { SKILL_RECOVERY_MAX_BYTES, SKILL_RECOVERY_MAX_ROOTS } from "./skill-recovery-capacity.ts";

const homes: string[] = [];
const instructions = "---\nname: runbook\ndescription: Fixture\n---\nGuide.\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-retired-skill-")); homes.push(root);
  const state = join(root, "state"); mkdirSync(state);
  const skill = join(root, "runbook"); mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), instructions);
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  const retired = { identity: skillRootIdentity(skill)!, hash: partHash(skillReleaseValue({ instructions, files: [{ path: "references/guide.md", content: "Guide.\n" }] })), executableFiles: [] };
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
  const quarantine = join(state, "retired-roots"), held = readdirSync(quarantine).find((name) => !name.endsWith(".json"))!;
  expect(readFileSync(join(quarantine, held, "references", "guide.md"), "utf8")).toBe("Guide.\n");
  if (process.platform !== "win32") {
    expect(lstatSync(quarantine).mode & 0o077).toBe(0);
    expect(lstatSync(join(quarantine, `${held}.json`)).mode & 0o077).toBe(0);
  }
});

it("keeps a Windows companion when its executable intent is unknown", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { skill, retired, state } = fixture();
    const { executableFiles: _executableFiles, ...unknown } = retired;
    expect(retireUnchangedSkillRoot(skill, unknown, state)).toHaveProperty("error");
    expect(readFileSync(join(skill, "references", "guide.md"), "utf8")).toBe("Guide.\n");
    expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
  } finally { Object.defineProperty(process, "platform", platform); }
});

it.skipIf(process.platform === "win32")("retains writes through an open descriptor after verification and across a process restart", () => {
  const { skill, retired, state } = fixture(), file = join(skill, "references", "guide.md"), fd = openSync(file, "a");
  try {
    expect(retireUnchangedSkillRoot(skill, retired, state, { afterVerify: () => { writeSync(fd, "during retirement\n"); } })).toEqual({ retired: true });
    writeSync(fd, "after retirement\n");
    const code = `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "skill-retirement.ts")).href)}); console.log(JSON.stringify(m.retireUnchangedSkillRoot(process.argv[1], JSON.parse(process.argv[2]), process.argv[3])));`;
    const restarted = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, skill, JSON.stringify(retired), state], { encoding: "utf8" });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim())).toEqual({ retired: true });
    writeSync(fd, "after retry\n");
    const quarantine = join(state, "retired-roots"), held = readdirSync(quarantine).find((name) => !name.endsWith(".json"))!;
    expect(readFileSync(join(quarantine, held, "references", "guide.md"), "utf8")).toBe("Guide.\nduring retirement\nafter retirement\nafter retry\n");
  } finally { closeSync(fd); }
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

it("retries an interrupted retention using its durable receipt", () => {
  const { skill, retired, state } = fixture();
  const failed = retireUnchangedSkillRoot(skill, retired, state, { afterVerify: () => { throw new Error("interrupted"); } });
  expect(failed).toHaveProperty("error", expect.stringContaining("still needs recovery"));
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  expect(names).toHaveLength(2);
  const receipt = JSON.parse(readFileSync(join(quarantine, names.find((name) => name.endsWith(".json"))!), "utf8"));
  expect(receipt).toEqual({ directory: skill, identity: retired.identity, hash: retired.hash, state: "pending" });
  expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
  expect(JSON.parse(readFileSync(join(quarantine, names.find((name) => name.endsWith(".json"))!), "utf8")).state).toBe("retained");
  expect(readdirSync(quarantine)).toHaveLength(2);
});

it.skipIf(process.platform === "win32")("retains an interrupted quarantine changed through an open descriptor", () => {
  const { skill, retired, state } = fixture();
  const fd = openSync(join(skill, "references", "guide.md"), "a");
  try {
    const failure = retireUnchangedSkillRoot(skill, retired, state, { afterVerify: () => { throw new Error("interrupted"); } });
    writeSync(fd, "late edit\n");
    expect(failure).toHaveProperty("error", expect.stringContaining("still needs recovery"));
    const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
    const held = join(quarantine, names.find((name) => !name.endsWith(".json"))!);
    writeFileSync(join(held, "new-local-data.txt"), "Preserve this");
    const code = `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "skill-retirement.ts")).href)}); console.log(JSON.stringify(m.retireUnchangedSkillRoot(process.argv[1], JSON.parse(process.argv[2]), process.argv[3])));`;
    const restarted = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, skill, JSON.stringify(retired), state], { encoding: "utf8" });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim())).toHaveProperty("error", expect.stringContaining(quarantine));
    writeSync(fd, "after restart\n");
    expect(readFileSync(join(held, "new-local-data.txt"), "utf8")).toBe("Preserve this");
    expect(readFileSync(join(held, "references", "guide.md"), "utf8")).toContain("late edit\nafter restart");
    expect(readdirSync(quarantine)).toHaveLength(2);
  } finally { closeSync(fd); }
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
  retireUnchangedSkillRoot(skill, retired, state, { afterVerify: () => { throw new Error("unavailable"); } });
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  const marker = join(quarantine, names.find((name) => name.endsWith(".json"))!);
  const outside = join(root, "outside"); writeFileSync(outside, "leave alone");
  rmSync(marker); symlinkSync(outside, marker);
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error");
  expect(readFileSync(outside, "utf8")).toBe("leave alone");
  expect(existsSync(join(quarantine, names.find((name) => !name.endsWith(".json"))!, "SKILL.md"))).toBe(true);
});

it("stops at the retained-root limit and succeeds after a whole archive is moved to backup", () => {
  const { root, skill, retired, state } = fixture(), quarantine = join(state, "retired-roots");
  mkdirSync(quarantine);
  for (let i = 0; i < SKILL_RECOVERY_MAX_ROOTS; i++) { const dir = join(quarantine, `old-${i}`); mkdirSync(dir); writeFileSync(join(dir, "work"), `kept ${i}`); }
  const fd = process.platform === "win32" ? null : openSync(join(skill, "references", "guide.md"), "a");
  try {
    const full = retireUnchangedSkillRoot(skill, retired, state);
    expect(full).toMatchObject({ reason: "capacity", error: expect.stringContaining(quarantine) });
    expect(readFileSync(join(skill, "references", "guide.md"), "utf8")).toBe("Guide.\n");
    renameSync(join(quarantine, "old-0"), join(root, "private-backup"));
    expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
    if (fd !== null) writeSync(fd, "after limit retry\n");
    const held = readdirSync(quarantine).find((name) => /^[a-f0-9]{64}$/.test(name))!;
    expect(readFileSync(join(quarantine, held, "references", "guide.md"), "utf8")).toBe(fd === null ? "Guide.\n" : "Guide.\nafter limit retry\n");
    expect(readFileSync(join(root, "private-backup", "work"), "utf8")).toBe("kept 0");
    expect(readdirSync(quarantine).filter((name) => !name.endsWith(".json"))).toHaveLength(SKILL_RECOVERY_MAX_ROOTS);
  } finally { if (fd !== null) closeSync(fd); }
});

it("stops at the retained-byte limit without deleting the new revision or existing data", () => {
  const { skill, retired, state } = fixture(), quarantine = join(state, "retired-roots"), old = join(quarantine, "old");
  mkdirSync(old, { recursive: true });
  const fd = openSync(join(old, "large"), "w");
  try { writeSync(fd, Buffer.from("x"), 0, 1, SKILL_RECOVERY_MAX_BYTES - 1); } finally { closeSync(fd); }
  expect(retireUnchangedSkillRoot(skill, retired, state)).toMatchObject({ reason: "capacity" });
  expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(instructions);
  expect(existsSync(join(old, "large"))).toBe(true);
});

it.skipIf(process.platform === "win32")("detects retained data grown through an open file before accepting another root", () => {
  const { root, skill, retired, state } = fixture(), fd = openSync(join(skill, "references", "guide.md"), "r+");
  try {
    expect(retireUnchangedSkillRoot(skill, retired, state)).toEqual({ retired: true });
    writeSync(fd, Buffer.from("x"), 0, 1, SKILL_RECOVERY_MAX_BYTES);
    const next = join(root, "next"); mkdirSync(next); writeFileSync(join(next, "SKILL.md"), instructions);
    const expected = { identity: skillRootIdentity(next)!, hash: partHash(skillReleaseValue({ instructions })) };
    expect(retireUnchangedSkillRoot(next, expected, state)).toMatchObject({ reason: "capacity" });
    expect(readFileSync(join(next, "SKILL.md"), "utf8")).toBe(instructions);
    const quarantine = join(state, "retired-roots"), held = readdirSync(quarantine).find((name) => /^[a-f0-9]{64}$/.test(name))!;
    expect(existsSync(join(quarantine, held, "references", "guide.md"))).toBe(true);
  } finally { closeSync(fd); }
});

it("keeps a partially deleted quarantine from the old cleanup path for recovery", () => {
  const { skill, retired, state } = fixture();
  expect(retireUnchangedSkillRoot(skill, retired, state, { afterVerify: () => { throw new Error("interrupted"); } })).toHaveProperty("error");
  const quarantine = join(state, "retired-roots"), names = readdirSync(quarantine);
  const held = join(quarantine, names.find((name) => !name.endsWith(".json"))!), marker = join(quarantine, names.find((name) => name.endsWith(".json"))!);
  writeFileSync(marker, JSON.stringify({ directory: skill, identity: retired.identity, hash: retired.hash }));
  rmSync(join(held, "references", "guide.md"));
  expect(retireUnchangedSkillRoot(skill, retired, state)).toHaveProperty("error", expect.stringContaining(quarantine));
  expect(readFileSync(join(held, "SKILL.md"), "utf8")).toBe(instructions);
  expect(existsSync(marker)).toBe(true);
});

it.skipIf(process.platform === "win32")("refuses a recovery tree with a symlink without reading its target", () => {
  const { root, skill, retired, state } = fixture(), quarantine = join(state, "retired-roots"), old = join(quarantine, "old");
  mkdirSync(old, { recursive: true });
  const outside = join(root, "outside"); writeFileSync(outside, "leave alone"); symlinkSync(outside, join(old, "link"));
  expect(retireUnchangedSkillRoot(skill, retired, state)).toMatchObject({ reason: "capacity" });
  expect(readFileSync(outside, "utf8")).toBe("leave alone");
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
});
