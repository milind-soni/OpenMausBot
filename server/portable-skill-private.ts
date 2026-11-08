import type { PackageSkill } from "../shared/package-format.ts";
import { snapshotPortableSkill } from "./portable-skill-files.ts";
import { listMigratableSkills, readSkillFile } from "./skills.ts";

export function exportPrivateSkill(botId: string, name: string) {
  const source = listMigratableSkills(botId, name, false)[0];
  if (!source?.directory) return null;
  return snapshotPortableSkill(source.directory, () => {
    const current = listMigratableSkills(botId, name)[0];
    return current?.intact && current.directory === source.directory ? readSkillFile(botId, name) : null;
  });
}

export function readInstalledSkillBundle(botId: string, name: string): Pick<PackageSkill, "instructions" | "files"> | null {
  const snapshot = exportPrivateSkill(botId, name);
  if (!snapshot || snapshot.skipped.length) return null;
  return { instructions: snapshot.instructions, ...(snapshot.files.length ? { files: snapshot.files } : {}) };
}
