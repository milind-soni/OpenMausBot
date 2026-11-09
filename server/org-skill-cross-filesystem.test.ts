import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const paths = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workspaces = mkdtempSync(join(realpathSync(process.env.OMB_SKILL_TEST_WORKSPACE_ROOT ?? tmpdir()), "omb-cross-workspaces-"));
  const data = mkdtempSync(join(realpathSync(process.env.OMB_SKILL_TEST_STATE_ROOT ?? tmpdir()), "omb-cross-state-"));
  vi.resetModules();
  process.env.OMB_DATA_DIR = data;
  return { workspaces, data };
});
vi.mock("./workspace.ts", async (original) => {
  const actual = await original<typeof import("./workspace.ts")>();
  const { mkdirSync } = await import("node:fs"), { join } = await import("node:path");
  return { ...actual, WORKSPACES_DIR: paths.workspaces, workspaceDir: (bot: string) => join(paths.workspaces, bot),
    ensureWorkspace: (bot: string) => { const path = join(paths.workspaces, bot); mkdirSync(join(path, "memory"), { recursive: true }); return path; } };
});

const { installOrgSkill, orgSkillStorage, readSkillFile, setSkillEnabled } = await import("./skills.ts");
const { ensureTaskWorkspaceWithSkills } = await import("./skill-task-links.ts");
const { replaceOrganizationSkill, recoverOrganizationSkillLinks } = await import("./org-skill-update.ts");
const { partHash, skillReleaseValue } = await import("./package-parts.ts");
const { writeSkillFolder } = await import("./skill-folder.ts");
const { setSkillUseGuard } = await import("./skill-use-guard.ts");
const { retireUnchangedSkillRoot, skillRootIdentity, skillRetirementCapacity } = await import("./skill-retirement.ts");
const { localSkillRetirementPath, readSkillRetirementReceipt } = await import("./skill-retirement-receipt.ts");
const { SKILL_RECOVERY_MAX_BYTES, SKILL_RECOVERY_MAX_ROOTS } = await import("./skill-recovery-capacity.ts");
const { removeOwnedNativeLink } = await import("./skill-native-link-removal.ts");
const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const differentDevices = fs.statSync(paths.workspaces).dev !== fs.statSync(paths.data).dev;
console.log(JSON.stringify({ crossFilesystem: differentDevices ? "real" : "injected-only", workspace: paths.workspaces,
  state: paths.data, workspaceDev: fs.statSync(paths.workspaces).dev, stateDev: fs.statSync(paths.data).dev }));

let sequence = 0;
const name = "runbook", instructions = "---\nname: runbook\ndescription: Fixture\n---\nRead the guide.\n";
function fixture() {
  const bot = `cross-${++sequence}`;
  const first = { instructions, files: [{ path: "references/guide.md", content: "Old guide\n" }] };
  const next = { instructions: `${instructions}Updated.\n`, files: [{ path: "references/guide.md", content: "New guide\n" },
    { path: "scripts/run.sh", content: "echo fixture\n", executable: true as const }] };
  const stamp = (release: string, skill: typeof first) => {
    const hash = partHash(skillReleaseValue(skill));
    return { installId: "a".repeat(32), key: name, release, r: hash, w: hash };
  };
  const before = stamp("1.0.0", first), after = stamp("1.1.0", next);
  expect(installOrgSkill(bot, "org:fixture", instructions, before, first.files)).toMatchObject({ enabled: true });
  const old = orgSkillStorage.skillDirectory(bot, name, orgSkillStorage.readManifest(bot)[name]!)!;
  expect(old).toBe(join(paths.workspaces, bot, "skills", name));
  expect(orgSkillStorage.skillStateDir(bot)).toBe(join(paths.data, "skill-state", bot));
  return { bot, first, next, before, after, old, state: orgSkillStorage.skillStateDir(bot) };
}
function receipt(state: string) {
  const quarantine = join(state, "retired-roots");
  const marker = join(quarantine, fs.readdirSync(quarantine).find((item) => item.endsWith(".json"))!);
  const record = readSkillRetirementReceipt(marker)!;
  expect(record?.localParent).toBeTruthy();
  return { marker, record, held: localSkillRetirementPath(record) };
}
beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(nativeFs.renameSync);
  setSkillUseGuard(() => false);
  if (!differentDevices) {
    const rename = nativeFs.renameSync;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if ((String(from).startsWith(paths.workspaces) && String(to).startsWith(paths.data)) ||
        (String(from).startsWith(paths.data) && String(to).startsWith(paths.workspaces))) {
        throw Object.assign(new Error("cross-device fixture"), { code: "EXDEV" });
      }
      rename(from, to);
    });
  }
});
afterEach(() => { vi.restoreAllMocks(); setSkillUseGuard(() => true); });
afterAll(() => { fs.rmSync(paths.workspaces, { recursive: true, force: true }); fs.rmSync(paths.data, { recursive: true, force: true }); });

it("publishes across filesystems, preserves disabled state and task inodes, then retires after task links switch", async () => {
  const { bot, next, before, after, old, state } = fixture();
  const task = ensureTaskWorkspaceWithSkills(bot, "task-one"), oldFile = join(old, "references/guide.md");
  const inode = fs.statSync(oldFile).ino, fd = fs.openSync(oldFile, "a");
  try {
    expect(setSkillEnabled(bot, name, false)).toMatchObject({ enabled: false });
    expect(await replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
    const active = orgSkillStorage.readManifest(bot)[name]!;
    expect(active).toMatchObject({ enabled: false, package: after, files: ["references/guide.md", "scripts/run.sh"], executableFiles: ["scripts/run.sh"] });
    expect(readSkillFile(bot, name)).toBe(next.instructions);
    const current = orgSkillStorage.skillDirectory(bot, name, active)!;
    expect(fs.readFileSync(join(current, "references/guide.md"), "utf8")).toBe("New guide\n");
    expect(fs.statSync(join(task, ".claude/skills", name, "references/guide.md")).ino).toBe(inode);
    expect(fs.readdirSync(join(state, "org-skill-staging"))).toEqual([]);
    ensureTaskWorkspaceWithSkills(bot, "task-one");
    expect(await recoverOrganizationSkillLinks(bot, name)).toEqual({ ok: true });
    const { record, held } = receipt(state);
    expect(record.state).toBe("retained");
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.statSync(join(held, "references/guide.md")).ino).toBe(inode);
    fs.writeSync(fd, "after retirement\n");
    const code = `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "skill-retirement.ts")).href)}); console.log(JSON.stringify(m.retireUnchangedSkillRoot(process.argv[1], JSON.parse(process.argv[2]), process.argv[3])));`;
    const restarted = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, old,
      JSON.stringify({ identity: record.identity, hash: before.w, executableFiles: [] }), state], { encoding: "utf8" });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim())).toEqual({ retired: true });
    fs.writeSync(fd, "after restart\n");
    expect(fs.readFileSync(join(held, "references/guide.md"), "utf8")).toBe("Old guide\nafter retirement\nafter restart\n");
  } finally { fs.closeSync(fd); }
});

it("retains a failed publication on its original filesystem and leaves the previous manifest active", async () => {
  const { bot, next, before, after, old, state } = fixture();
  const manifest = orgSkillStorage.readManifest(bot);
  expect(await replaceOrganizationSkill(bot, "org:fixture", next, after, before, {
    writeManifest: () => { throw new Error("fixture manifest failure"); },
  })).toHaveProperty("error", expect.stringContaining("fixture manifest failure"));
  expect(orgSkillStorage.readManifest(bot)).toEqual(manifest);
  expect(fs.readFileSync(join(old, "references/guide.md"), "utf8")).toBe("Old guide\n");
  expect(receipt(state).record.state).toBe("retained");
  expect(fs.readdirSync(join(state, "org-skill-staging"))).toEqual([]);
});

it("switches enabled native and task links across two releases and retains the prior revision inode", async () => {
  const { bot, next, before, after, state } = fixture();
  expect(await replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
  const previous = orgSkillStorage.readManifest(bot)[name]!;
  const directory = orgSkillStorage.skillDirectory(bot, name, previous)!;
  const task = ensureTaskWorkspaceWithSkills(bot, "task-two"), file = join(directory, "scripts/run.sh");
  const inode = fs.statSync(file).ino, fd = fs.openSync(file, "a");
  const third = { ...next, instructions: `${next.instructions}Third release.\n` };
  const hash = partHash(skillReleaseValue(third)), stamp = { ...after, release: "1.2.0", r: hash, w: hash };
  try {
    expect(await replaceOrganizationSkill(bot, "org:fixture", third, stamp, after)).toEqual({ updated: true });
    for (const family of [".claude", ".agents", ".grok"]) {
      expect(fs.readFileSync(join(paths.workspaces, bot, family, "skills", name, "SKILL.md"), "utf8")).toBe(third.instructions);
      expect(fs.statSync(join(task, family, "skills", name, "scripts/run.sh")).ino).toBe(inode);
    }
    ensureTaskWorkspaceWithSkills(bot, "task-two");
    expect(await recoverOrganizationSkillLinks(bot, name)).toEqual({ ok: true });
    const quarantine = join(state, "retired-roots");
    const record = fs.readdirSync(quarantine).filter((item) => item.endsWith(".json"))
      .map((item) => readSkillRetirementReceipt(join(quarantine, item))!).find((record) => record.directory === directory)!;
    const held = localSkillRetirementPath(record);
    fs.writeSync(fd, "late script edit\n");
    expect(fs.statSync(join(held, "scripts/run.sh")).ino).toBe(inode);
    expect(fs.readFileSync(join(held, "scripts/run.sh"), "utf8")).toContain("late script edit");
    expect(fs.readFileSync(join(task, ".agents/skills", name, "SKILL.md"), "utf8")).toBe(third.instructions);
  } finally { fs.closeSync(fd); }
});

it("rejects a substituted publication inode after the local rename", async () => {
  const { bot, next, before, after } = fixture(), rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    rename(from, to);
    if (String(from).includes("/.prepare-")) {
      rename(to, `${to}-original`);
      writeSkillFolder(String(to), next.instructions, [
        { path: "references/guide.md", content: "New guide\n" },
        { path: "scripts/run.sh", content: "echo fixture\n", executable: true },
      ], { recordExecutableIntent: true });
    }
  });
  expect(await replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toHaveProperty("error");
  expect(orgSkillStorage.readManifest(bot)[name]!.package).toEqual(before);
});

it.each(["bytes", "instructions", "mode", "symlink"] as const)("rejects %s tampering in destination staging", async (tamper) => {
  const { bot, next, before, after, old } = fixture();
  const result = await replaceOrganizationSkill(bot, "org:fixture", next, after, before, { writeFolder: (...args) => {
    writeSkillFolder(...args);
    if (!args[0].startsWith(paths.workspaces)) return;
    const file = join(args[0], tamper === "instructions" ? "SKILL.md" : "scripts/run.sh");
    if (tamper === "mode") fs.chmodSync(file, 0o600);
    else if (tamper === "symlink") { fs.unlinkSync(file); fs.symlinkSync(join(old, "SKILL.md"), file); }
    else fs.writeFileSync(file, "tampered\n");
  } });
  expect(result).toHaveProperty("error");
  expect(orgSkillStorage.readManifest(bot)[name]!.package).toEqual(before);
  expect(fs.readFileSync(join(old, "references/guide.md"), "utf8")).toBe("Old guide\n");
});

it("retries an interrupted local receipt and accounts for late writes, root limits and unsafe receipts", async () => {
  const { old, before, state } = fixture();
  const expected = { identity: skillRootIdentity(old)!, hash: before.w, executableFiles: [] };
  expect(retireUnchangedSkillRoot(old, expected, state, { afterVerify: () => { throw new Error("fixture interruption"); } })).toHaveProperty("error");
  const { marker, held } = receipt(state);
  expect(retireUnchangedSkillRoot(old, expected, state)).toEqual({ retired: true });
  const next = join(paths.workspaces, "capacity-next"); fs.mkdirSync(next); fs.writeFileSync(join(next, "SKILL.md"), instructions);
  const quarantine = join(state, "retired-roots");
  for (let n = 0; n < SKILL_RECOVERY_MAX_ROOTS - 1; n++) fs.mkdirSync(join(quarantine, `other-${n}`));
  expect(skillRetirementCapacity(state, next)).toHaveProperty("reason", "capacity");
  for (let n = 0; n < SKILL_RECOVERY_MAX_ROOTS - 1; n++) fs.rmSync(join(quarantine, `other-${n}`), { recursive: true });
  const fd = fs.openSync(join(held, "references/guide.md"), "r+");
  try { fs.writeSync(fd, Buffer.from("x"), 0, 1, SKILL_RECOVERY_MAX_BYTES); } finally { fs.closeSync(fd); }
  expect(skillRetirementCapacity(state, next)).toHaveProperty("reason", "capacity");
  fs.truncateSync(join(held, "references/guide.md"), 10);
  expect(skillRetirementCapacity(state, next)).toEqual({ ok: true });
  const saved = fs.readFileSync(marker, "utf8");
  fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(saved), directory: "/../outside" }));
  expect(skillRetirementCapacity(state, next)).toHaveProperty("reason", "capacity");
  expect(retireUnchangedSkillRoot(old, expected, state)).toHaveProperty("error");
  fs.writeFileSync(marker, saved);
  fs.renameSync(held, `${held}-backup`); fs.symlinkSync(`${held}-backup`, held);
  expect(skillRetirementCapacity(state, next)).toHaveProperty("reason", "capacity");
  expect(retireUnchangedSkillRoot(old, expected, state)).toHaveProperty("error");
});

it("keeps late descriptor edits on an interrupted local retirement across restart", () => {
  const { old, before, state } = fixture(), fd = fs.openSync(join(old, "references/guide.md"), "a");
  const expected = { identity: skillRootIdentity(old)!, hash: before.w, executableFiles: [] };
  try {
    expect(retireUnchangedSkillRoot(old, expected, state, { afterVerify: () => { throw new Error("fixture interruption"); } })).toHaveProperty("error");
    const { held, record } = receipt(state);
    expect(record.state).toBe("pending");
    fs.writeSync(fd, "late edit\n");
    const code = `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "skill-retirement.ts")).href)}); console.log(JSON.stringify(m.retireUnchangedSkillRoot(process.argv[1], JSON.parse(process.argv[2]), process.argv[3])));`;
    const restarted = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, old, JSON.stringify(expected), state], { encoding: "utf8" });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout.trim())).toHaveProperty("error", expect.stringContaining("still needs recovery"));
    fs.writeSync(fd, "after restart\n");
    expect(fs.readFileSync(join(held, "references/guide.md"), "utf8")).toBe("Old guide\nlate edit\nafter restart\n");
  } finally { fs.closeSync(fd); }
});

it("rejects a replaced local recovery parent even when the retained inode was moved into it", () => {
  const { bot, old, before, state } = fixture();
  const expected = { identity: skillRootIdentity(old)!, hash: before.w, executableFiles: [] };
  expect(retireUnchangedSkillRoot(old, expected, state)).toEqual({ retired: true });
  const { held } = receipt(state), parent = join(paths.workspaces, bot, "skills"), backup = `${parent}-backup`;
  fs.renameSync(parent, backup); fs.mkdirSync(parent);
  fs.renameSync(join(backup, held.slice(parent.length + 1)), held);
  const next = join(parent, "next"); fs.mkdirSync(next); fs.writeFileSync(join(next, "SKILL.md"), instructions);
  expect(skillRetirementCapacity(state, next)).toHaveProperty("reason", "capacity");
  expect(retireUnchangedSkillRoot(old, expected, state)).toHaveProperty("error");
  expect(fs.readFileSync(join(held, "references/guide.md"), "utf8")).toBe("Old guide\n");
});

it("preserves a file substituted for a native link when its original name is occupied during local recovery", () => {
  const { bot, old, state } = fixture(), parent = join(paths.workspaces, bot, ".claude/skills"), link = join(parent, name);
  let fd = -1;
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    rename(from, to);
    if (String(from) === link && String(to).includes(".omb-link-removal-")) fs.writeFileSync(link, "new occupant");
  });
  try {
    expect(removeOwnedNativeLink(state, link, join(paths.workspaces, bot), name, false, () => {
      fs.unlinkSync(link); fs.writeFileSync(link, "preserve original"); fd = fs.openSync(link, "a");
    })).toBe("preserved");
    fs.writeSync(fd, " and late edit");
    const quarantine = join(state, "link-removal");
    const record = JSON.parse(fs.readFileSync(join(quarantine, fs.readdirSync(quarantine).find((item) => item.endsWith(".json"))!), "utf8"));
    expect(fs.readFileSync(record.moved, "utf8")).toBe("preserve original and late edit");
    expect(fs.readFileSync(link, "utf8")).toBe("new occupant");
    expect(fs.readFileSync(join(old, "SKILL.md"), "utf8")).toBe(instructions);
  } finally { if (fd >= 0) fs.closeSync(fd); }
});
