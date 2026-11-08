import { join } from "node:path";
import type { SkillManifestEntry } from "./skills.ts";
import { retireUnchangedSkillRoot, skillRootHasExpectedContent, skillRootIdentity } from "./skill-retirement.ts";
import { nativeSkillLinksMayReferTo } from "./skill-native-reference.ts";
import { taskSkillsMayReferTo } from "./skill-task-references.ts";
import { skillMayBeInUse } from "./skill-use-guard.ts";

type Manifest = Record<string, SkillManifestEntry>;
type Storage = {
  readManifest(botId: string): Manifest;
  writeManifest(botId: string, manifest: Manifest): void;
  skillDirectory(botId: string, name: string, entry: SkillManifestEntry): string | null;
  ensureSkillsRoot(botId: string): string | null;
  skillStateDir(botId: string): string;
  syncSkillLinks(botId: string, options?: { onlyName?: string }): boolean;
};

export function removeOrganizationSkill(botId: string, name: string, storage: Storage, options: { retire?: typeof retireUnchangedSkillRoot } = {}): { removed: true } | { error: string } {
  if (skillMayBeInUse(botId)) return { error: "wait until the bot finishes using its skills" };
  const manifest = storage.readManifest(botId), entry = manifest[name];
  if (!entry) return { removed: true };
  if (entry.pendingRetirements?.length) return { error: "wait until the previous skill revision is synchronized" };
  const root = storage.ensureSkillsRoot(botId);
  if (!root) return { error: "the workspace skills path is not a real directory" };
  if (entry.storageRevision && entry.retiredRoot) {
    const previous = join(root, name);
    if (nativeSkillLinksMayReferTo(botId, name, previous) || taskSkillsMayReferTo(botId, name, [previous])[0]) {
      return { error: "the skill removal is waiting for previous links to clear" };
    }
    const retired = (options.retire ?? retireUnchangedSkillRoot)(previous, entry.retiredRoot, storage.skillStateDir(botId));
    if ("error" in retired) return retired;
  }
  let pending = entry.pendingRemoval;
  if (!pending) {
    const directory = storage.skillDirectory(botId, name, entry), identity = directory && skillRootIdentity(directory);
    if (!directory || !identity || !entry.package || !skillRootHasExpectedContent(directory, entry.package.w)) {
      return { error: "the skill folder changed; move it before removing this skill" };
    }
    pending = { identity, hash: entry.package.w, ...(entry.storageRevision ? { revision: entry.storageRevision } : {}) };
    entry.enabled = false;
    entry.pendingRemoval = pending;
    try { storage.writeManifest(botId, manifest); }
    catch { return { error: "the skill removal could not be recorded safely" }; }
  }
  const directory = pending.revision ? join(root, ".revisions", pending.revision) : join(root, name);
  try { if (!storage.syncSkillLinks(botId, { onlyName: name }) || nativeSkillLinksMayReferTo(botId, name, directory)) return { error: "the skill removal is waiting for native links to synchronize" }; }
  catch { return { error: "the skill removal is waiting for native links to synchronize" }; }
  if (skillMayBeInUse(botId) || taskSkillsMayReferTo(botId, name, [directory])[0]) {
    return { error: "the skill removal is waiting for task links to clear" };
  }
  const retired = (options.retire ?? retireUnchangedSkillRoot)(directory, pending, storage.skillStateDir(botId));
  if ("error" in retired) return retired;
  const latest = storage.readManifest(botId), now = latest[name];
  if (!now?.pendingRemoval || JSON.stringify(now.pendingRemoval) !== JSON.stringify(pending)) return { error: "the skill changed during removal" };
  delete latest[name];
  try { storage.writeManifest(botId, latest); }
  catch { return { error: "the completed skill removal needs to be recorded" }; }
  return { removed: true };
}
