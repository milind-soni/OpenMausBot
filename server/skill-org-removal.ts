import { join } from "node:path";
import type { SkillManifestEntry } from "./skills.ts";
import { canonicalJson } from "../shared/package-format.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { readInstalledSkillBundle } from "./portable-skill-private.ts";
import { notifyPendingOrgSkillRemoval } from "./org-skill-retry.ts";
import { retireUnchangedSkillRoot, skillRootHasExpectedContent, skillRootIdentity } from "./skill-retirement.ts";
import { nativeSkillLinksMayReferTo } from "./skill-native-reference.ts";
import { taskSkillsMayReferTo } from "./skill-task-references.ts";
import { skillMayBeInUse } from "./skill-use-guard.ts";
import { skillUpdateGuardPath, skillUpdateNeedsRecovery } from "./skill-recovery-capacity.ts";

type Manifest = Record<string, SkillManifestEntry>;
type Storage = {
  readManifest(botId: string): Manifest;
  writeManifest(botId: string, manifest: Manifest): void;
  skillDirectory(botId: string, name: string, entry: SkillManifestEntry): string | null;
  ensureSkillsRoot(botId: string): string | null;
  skillStateDir(botId: string): string;
  syncSkillLinks(botId: string, options?: { onlyName?: string }): boolean;
};

export async function removeOrganizationSkill(botId: string, name: string, storage: Storage, options: { retire?: typeof retireUnchangedSkillRoot } = {}): Promise<{ removed: true } | { error: string }> {
  if (skillMayBeInUse(botId)) return { error: "wait until the bot finishes using its skills" };
  const manifest = storage.readManifest(botId), entry = manifest[name];
  if (!entry) return { removed: true };
  if (skillUpdateNeedsRecovery(storage.skillStateDir(botId), name)) return { error: `a previous skill update needs recovery; inspect ${skillUpdateGuardPath(storage.skillStateDir(botId), name)} before removing this skill` };
  if (entry.pendingRetirements?.length) return { error: "wait until the previous skill revision is synchronized" };
  const root = storage.ensureSkillsRoot(botId);
  if (!root) return { error: "the workspace skills path is not a real directory" };
  if (entry.storageRevision && entry.retiredRoot) {
    const previous = join(root, name);
    const referenced = await taskSkillsMayReferTo(botId, name, [previous]);
    if (skillMayBeInUse(botId) || skillUpdateNeedsRecovery(storage.skillStateDir(botId), name) ||
      canonicalJson(storage.readManifest(botId)[name]) !== canonicalJson(entry)) return { error: "the skill or its use changed during removal" };
    if (nativeSkillLinksMayReferTo(botId, name, previous) || referenced[0]) {
      return { error: "the skill removal is waiting for previous links to clear" };
    }
    const retired = (options.retire ?? retireUnchangedSkillRoot)(previous, entry.retiredRoot, storage.skillStateDir(botId));
    if ("error" in retired) return retired;
  }
  let pending = entry.pendingRemoval;
  if (!pending) {
    if (process.platform === "win32" && entry.filesSha256 && !entry.executableFiles) {
      return { error: "the existing Windows skill has no recorded executable intent; its folder needs manual recovery before removal" };
    }
    const directory = storage.skillDirectory(botId, name, entry), identity = directory && skillRootIdentity(directory);
    const unstamped = entry.package ? null : readInstalledSkillBundle(botId, name);
    const hash = entry.package?.w ?? (unstamped && partHash(skillReleaseValue(unstamped)));
    if (!directory || !identity || !hash || !skillRootHasExpectedContent(directory, hash, entry.executableFiles)) {
      return { error: "the skill folder changed; move it before removing this skill" };
    }
    pending = { identity, hash, ...(entry.storageRevision ? { revision: entry.storageRevision } : {}),
      ...(entry.executableFiles ? { executableFiles: [...entry.executableFiles] } : {}) };
    entry.enabled = false;
    entry.pendingRemoval = pending;
    try { storage.writeManifest(botId, manifest); }
    catch { return { error: "the skill removal could not be recorded safely" }; }
  }
  notifyPendingOrgSkillRemoval(botId);
  const directory = pending.revision ? join(root, ".revisions", pending.revision) : join(root, name);
  try { if (!storage.syncSkillLinks(botId, { onlyName: name }) || nativeSkillLinksMayReferTo(botId, name, directory)) return { error: "the skill removal is waiting for native links to synchronize" }; }
  catch { return { error: "the skill removal is waiting for native links to synchronize" }; }
  const referenced = await taskSkillsMayReferTo(botId, name, [directory]);
  if (skillMayBeInUse(botId) || skillUpdateNeedsRecovery(storage.skillStateDir(botId), name) ||
    canonicalJson(storage.readManifest(botId)[name]) !== canonicalJson(entry)) return { error: "the skill or its use changed during removal" };
  if (nativeSkillLinksMayReferTo(botId, name, directory)) return { error: "the skill removal is waiting for native links to synchronize" };
  if (referenced[0]) {
    return { error: "the skill removal is waiting for task links to clear" };
  }
  const retired = (options.retire ?? retireUnchangedSkillRoot)(directory, pending, storage.skillStateDir(botId));
  if ("error" in retired) {
    const recovery = retired.reason === "capacity" ? "capacity" : "attention";
    if (pending.recovery !== recovery) {
      const latest = storage.readManifest(botId), now = latest[name];
      if (now?.pendingRemoval && canonicalJson(now.pendingRemoval) === canonicalJson(pending)) {
        const { recovery: _previous, ...rest } = pending;
        now.pendingRemoval = { ...rest, recovery };
        try { storage.writeManifest(botId, latest); } catch {}
      }
    }
    return { error: retired.error };
  }
  const latest = storage.readManifest(botId), now = latest[name];
  if (!now?.pendingRemoval || canonicalJson(now.pendingRemoval) !== canonicalJson(pending)) return { error: "the skill changed during removal" };
  delete latest[name];
  try { storage.writeManifest(botId, latest); }
  catch { return { error: "the completed skill removal needs to be recorded" }; }
  return { removed: true };
}
