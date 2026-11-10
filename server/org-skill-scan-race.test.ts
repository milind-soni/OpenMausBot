import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { recoverOrganizationSkillLinks, replaceOrganizationSkill } from "./org-skill-update.ts";
import { installOrgSkill, orgSkillStorage, removeSkill } from "./skills.ts";
import { ensureTaskWorkspaceWithSkills } from "./skill-task-links.ts";
import { TASK_WORKSPACES_DIR, workspaceDir } from "./workspace.ts";
import { setSkillUseGuard } from "./skill-use-guard.ts";
import { skillUpdateGuardPath } from "./skill-recovery-capacity.ts";

const name = "runbook", instructions = "---\nname: runbook\ndescription: Fixture\n---\nGuide.\n";
let sequence = 0;
const bots: string[] = [];
afterEach(() => {
  setSkillUseGuard(() => true);
  for (const bot of bots.splice(0)) {
    rmSync(workspaceDir(bot), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "skill-state", bot), { recursive: true, force: true });
    rmSync(join(TASK_WORKSPACES_DIR, bot), { recursive: true, force: true });
  }
});
function fixture() {
  const bot = `scan-race-${++sequence}`; bots.push(bot);
  const first = { instructions }, next = { instructions: `${instructions}Updated.\n` };
  const stamp = (release: string, skill: typeof first) => {
    const hash = partHash(skillReleaseValue(skill));
    return { installId: "a".repeat(32), key: name, release, r: hash, w: hash };
  };
  const before = stamp("1.0.0", first), after = stamp("1.1.0", next);
  setSkillUseGuard(() => false);
  expect(installOrgSkill(bot, "org:fixture", instructions, before)).toMatchObject({ enabled: true });
  const old = orgSkillStorage.skillDirectory(bot, name, orgSkillStorage.readManifest(bot)[name]!)!;
  return { bot, next, before, after, old };
}
function dormantTasks(bot: string) {
  for (let n = 0; n < 128; n++) mkdirSync(join(TASK_WORKSPACES_DIR, bot, `dormant-${n}`), { recursive: true });
}

it.each(["active-use", "manifest", "native-link", "guard"] as const)("keeps the old inode when %s changes during an awaited scan", async (change) => {
  const { bot, next, before, after, old } = fixture();
  ensureTaskWorkspaceWithSkills(bot, "task-one");
  expect(await replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
  ensureTaskWorkspaceWithSkills(bot, "task-one");
  dormantTasks(bot);
  const inode = lstatSync(old).ino;
  let completed = false, changedDuringScan = false;
  const timer = setTimeout(() => {
    changedDuringScan = !completed;
    if (change === "active-use") setSkillUseGuard(() => true);
    if (change === "manifest") {
      const manifest = orgSkillStorage.readManifest(bot); manifest[name]!.enabled = false; orgSkillStorage.writeManifest(bot, manifest);
    }
    if (change === "native-link") {
      const link = join(workspaceDir(bot), ".claude/skills", name); rmSync(link); symlinkSync(old, link, "junction");
    }
    if (change === "guard") writeFileSync(skillUpdateGuardPath(orgSkillStorage.skillStateDir(bot), name), "{}");
  }, 0);
  try {
    const result = await recoverOrganizationSkillLinks(bot, name); completed = true;
    expect(changedDuringScan).toBe(true);
    expect(result).toHaveProperty("error");
    expect(lstatSync(old).ino).toBe(inode);
    expect(orgSkillStorage.readManifest(bot)[name]!.pendingRetirements).toHaveLength(1);
  } finally { clearTimeout(timer); }
});

it("rechecks the recovery guard before removing a skill after its task scan", async () => {
  const { bot, old } = fixture();
  dormantTasks(bot);
  let completed = false, changedDuringScan = false;
  const timer = setTimeout(() => {
    changedDuringScan = !completed;
    const marker = skillUpdateGuardPath(orgSkillStorage.skillStateDir(bot), name);
    mkdirSync(join(orgSkillStorage.skillStateDir(bot), "org-skill-staging"), { recursive: true });
    writeFileSync(marker, "{}");
  }, 0);
  try {
    expect(await removeSkill(bot, name)).toHaveProperty("error", expect.stringContaining("changed during removal"));
    completed = true;
    expect(changedDuringScan).toBe(true);
    expect(existsSync(old)).toBe(true);
    expect(orgSkillStorage.readManifest(bot)[name]!.pendingRemoval).toBeTruthy();
  } finally { clearTimeout(timer); }
});
