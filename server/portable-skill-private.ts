import type { PackageSkill } from "../shared/package-format.ts";
import { portableFilesForDisk, snapshotPortableSkill } from "./portable-skill-files.ts";
import { skillFolderDigest } from "./skill-folder.ts";
import { skillReferencesSha256 } from "./skill-storage.ts";
import { listMigratableSkills, readSkillFile, readSkillReferences } from "./skills.ts";

export function exportPrivateSkill(botId: string, name: string) {
  const source = listMigratableSkills(botId, name, false)[0];
  if (!source?.directory) return null;
  const references = source.files ?? readSkillReferences(botId, name)?.map((file) => file.path);
  if (!references) return null;
  const executablePaths = source.filesSha256 ? source.executableFiles ?? null : [];
  return snapshotPortableSkill(source.directory, () => {
    const current = listMigratableSkills(botId, name)[0];
    return current?.intact && current.directory === source.directory ? readSkillFile(botId, name) : null;
  }, references, (files) => {
    const captured = portableFilesForDisk(files);
    if (source.filesSha256) return skillFolderDigest(source.directory!, references, { captured, remember: false, executablePaths: source.executableFiles }) === source.filesSha256;
    if (source.referencesSha256) return captured.every((file) => !file.executable) && skillReferencesSha256(captured) === source.referencesSha256;
    return references.length === 0;
  }, executablePaths);
}

export function readInstalledSkillBundle(botId: string, name: string): Pick<PackageSkill, "instructions" | "files"> | null {
  const snapshot = exportPrivateSkill(botId, name);
  if (!snapshot || snapshot.skipped.length) return null;
  return { instructions: snapshot.instructions, ...(snapshot.files.length ? { files: snapshot.files } : {}) };
}
