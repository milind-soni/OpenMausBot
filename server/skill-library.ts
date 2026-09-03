// Bundled skill catalog. Skills remain isolated resources so adding or
// disabling one does not require changing a provider driver. A future Skills
// UI can use the same manifests; today enabled built-ins are selected by their
// declared trigger terms and mounted capabilities.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
  /** Tool ids owned by this skill. A declaration is not itself a grant. */
  tools: string[];
  /** Lowercase skill ids that must be selected and admitted with this skill. */
  dependencies?: string[];
}

export interface BundledSkill {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
  origin?: SkillOrigin;
  metadata?: SkillCatalogMetadata;
}

export type SkillOrigin = "built-in" | "recorded" | "imported";

export interface SkillCatalogMetadata {
  source?: string;
  importedAt?: string;
  warnings?: string[];
  skippedFiles?: string[];
}

export interface SkillGrantState {
  /** undefined preserves the default-enabled catalog behavior; [] denies all. */
  skillGrants?: readonly string[];
  /** undefined preserves all tools declared by the effective skills; [] denies all. */
  skillToolGrants?: readonly string[];
}

export type SkillSelectionReason =
  | "selected"
  | "dependency"
  | "unknown"
  | "trigger-mismatch"
  | "skill-denied"
  | "capability-missing"
  | "tool-denied"
  | "dependency-missing"
  | "dependency-cycle"
  | "dependency-invalid"
  | "selection-overflow";

export interface SkillDecision {
  skillId: string;
  reason: SkillSelectionReason;
  requiredCapabilities: string[];
  declaredToolIds: string[];
}

export interface SkillSelection {
  selectedSkills: BundledSkill[];
  mountedSkillToolIds: string[];
  decisions: SkillDecision[];
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
  tools: string[];
  dependencies: string[];
  origin: SkillOrigin;
  status: "available";
  source?: string;
  importedAt?: string;
  warnings: string[];
  skippedFiles: string[];
}

export const MAX_MANUAL_SKILLS = 8;

/** Provider capability ids admitted to skill manifests. Only literal true
 * flags count; string/array capability metadata is intentionally excluded.
 * Sorting makes audit and tests stable while automatically covering future
 * boolean flags added by provider adapters. */
export function enabledProviderCapabilityIds(capabilities: Record<string, unknown>): string[] {
  return Object.entries(capabilities)
    .filter(([, value]) => value === true)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_TOOL_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function compareDeterministically(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return null;
  const values = value.map((item) => (item as string).trim());
  if (new Set(values).size !== values.length) throw new Error("duplicate list entry");
  return values.sort(compareDeterministically);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareDeterministically);
}

export function parseSkillManifest(value: unknown, directory: string): SkillManifest {
  if (!value || typeof value !== "object") throw new Error(`${directory}/manifest.json is invalid`);
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  let triggerTerms: string[] | null;
  let requiredCapabilities: string[] | null;
  let tools: string[] | null;
  let dependencies: string[] | undefined;
  try {
    triggerTerms = stringList(raw.triggerTerms);
    requiredCapabilities = stringList(raw.requiredCapabilities);
    tools = stringList(raw.tools);
    dependencies = raw.dependencies === undefined ? undefined : stringList(raw.dependencies) ?? undefined;
  } catch {
    throw new Error(`${directory}/manifest.json has duplicate list entries`);
  }
  if (!SAFE_ID.test(id) || id !== basename(directory)) throw new Error(`${directory}/manifest.json has an invalid id`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${directory}/manifest.json has no name`);
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error(`${directory}/manifest.json has an invalid version`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${directory}/manifest.json has no description`);
  if (typeof raw.defaultEnabled !== "boolean") throw new Error(`${directory}/manifest.json has no defaultEnabled flag`);
  if (!triggerTerms?.length) throw new Error(`${directory}/manifest.json has no trigger terms`);
  if (!requiredCapabilities) throw new Error(`${directory}/manifest.json has invalid capabilities`);
  if (!tools || tools.some((tool) => !SAFE_TOOL_ID.test(tool))) throw new Error(`${directory}/manifest.json has invalid tools`);
  if (raw.dependencies !== undefined && !dependencies) throw new Error(`${directory}/manifest.json has invalid dependencies`);
  if (dependencies?.some((dependency) => !SAFE_ID.test(dependency))) {
    throw new Error(`${directory}/manifest.json has invalid dependencies`);
  }
  if (dependencies?.includes(id)) throw new Error(`${directory}/manifest.json has a self dependency`);
  return {
    id,
    name: raw.name.trim(),
    version: raw.version,
    description: raw.description.trim(),
    defaultEnabled: raw.defaultEnabled,
    triggerTerms,
    requiredCapabilities,
    tools,
    ...(dependencies ? { dependencies } : {}),
  };
}

function loadSkillDirectory(
  directory: string,
  options: { allowMissingTools?: boolean; origin?: SkillOrigin } = {},
): BundledSkill | null {
  const manifestPath = join(directory, "manifest.json");
  const skillPath = join(directory, "SKILL.md");
  if (!existsSync(manifestPath) || !existsSync(skillPath)) return null;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (options.allowMissingTools && raw && typeof raw === "object" && !Array.isArray(raw) && !Object.hasOwn(raw, "tools")) {
    raw.tools = [];
  }
  const manifest = parseSkillManifest(raw, directory);
  const instructions = readFileSync(skillPath, "utf8").trim();
  if (!instructions.startsWith("---")) throw new Error(`${skillPath} has no skill frontmatter`);
  const origin = options.origin ?? (raw.origin === "imported" ? "imported" : "recorded");
  const metadata: SkillCatalogMetadata = {
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
    ...(typeof raw.importedAt === "string" ? { importedAt: raw.importedAt } : {}),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((item: unknown): item is string => typeof item === "string")
      : [],
    skippedFiles: Array.isArray(raw.skippedFiles)
      ? raw.skippedFiles.filter((item: unknown): item is string => typeof item === "string")
      : [],
  };
  return { manifest, instructions, directory, origin, metadata };
}

export function loadBundledSkills(root = process.env.OMB_SKILLS_DIR || join(process.cwd(), "skills")): BundledSkill[] {
  if (!existsSync(root)) return [];
  const skills: BundledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    // Older bundled manifests predate the optional tool declaration. Treat a
    // missing list as an empty declaration while still validating any list
    // that is present.
    const skill = loadSkillDirectory(directory, { allowMissingTools: true, origin: "built-in" });
    if (skill) skills.push(skill);
  }
  return skills;
}

export function skillCatalog(skills: readonly BundledSkill[]): SkillCatalogEntry[] {
  return skills.map(({ manifest, origin = "built-in", metadata }) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    defaultEnabled: manifest.defaultEnabled,
    triggerTerms: [...manifest.triggerTerms],
    requiredCapabilities: [...manifest.requiredCapabilities],
    tools: [...manifest.tools],
    dependencies: [...(manifest.dependencies ?? [])],
    origin,
    status: "available",
    ...(metadata?.source ? { source: metadata.source } : {}),
    ...(metadata?.importedAt ? { importedAt: metadata.importedAt } : {}),
    warnings: [...(metadata?.warnings ?? [])],
    skippedFiles: [...(metadata?.skippedFiles ?? [])],
  }));
}

export function filterSkillGrantState(
  grants: SkillGrantState,
  skills: readonly BundledSkill[],
): SkillGrantState {
  const skillIds = new Set(skills.map(({ manifest }) => manifest.id));
  const toolIds = new Set(skills.flatMap(({ manifest }) => manifest.tools));
  const filtered: SkillGrantState = {};
  if (grants.skillGrants !== undefined) {
    filtered.skillGrants = sortedUnique(grants.skillGrants.filter((id): id is string => typeof id === "string" && skillIds.has(id)));
  }
  if (grants.skillToolGrants !== undefined) {
    filtered.skillToolGrants = sortedUnique(grants.skillToolGrants.filter((id): id is string => typeof id === "string" && toolIds.has(id)));
  }
  return filtered;
}

export function validateSkillGrantPatch(
  input: { skillGrants?: unknown; skillToolGrants?: unknown },
  skills: readonly BundledSkill[],
): SkillGrantState {
  const knownSkills = new Set(skills.map(({ manifest }) => manifest.id));
  const knownTools = new Set(skills.flatMap(({ manifest }) => manifest.tools));
  const patch: SkillGrantState = {};
  for (const [field, known] of [["skillGrants", knownSkills], ["skillToolGrants", knownTools]] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${field} must be a list of known ids`);
    }
    const ids = sortedUnique(value as string[]);
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw new Error(`${field} contains unknown id "${unknown}"`);
    patch[field] = ids;
  }
  return patch;
}

export function effectiveSkillIds(
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): string[] {
  if (grants.skillGrants !== undefined) {
    const known = new Set(skills.map(({ manifest }) => manifest.id));
    return sortedUnique(grants.skillGrants.filter((id): id is string => typeof id === "string" && known.has(id)));
  }
  return skills.filter(({ manifest }) => manifest.defaultEnabled).map(({ manifest }) => manifest.id).sort(compareDeterministically);
}

export function effectiveSkillToolIds(
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): string[] {
  const selected = new Set(effectiveSkillIds(skills, grants));
  if (grants.skillToolGrants !== undefined) {
    const known = new Set(skills.flatMap(({ manifest }) => manifest.tools));
    return sortedUnique(grants.skillToolGrants.filter((id): id is string => typeof id === "string" && known.has(id)));
  }
  return sortedUnique(
    skills.filter(({ manifest }) => selected.has(manifest.id)).flatMap(({ manifest }) => manifest.tools),
  );
}

/** Decide trigger-based bundled skill admission while applying the bot's
 * skill and tool grants plus provider capabilities. */
export function decideBundledSkills(
  triggerText: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): SkillSelection {
  const haystack = triggerText.toLowerCase();
  const available = new Set(capabilities);
  const grantedSkills = new Set(effectiveSkillIds(skills, grants));
  const grantedTools = new Set(effectiveSkillToolIds(skills, grants));
  const decisions: SkillDecision[] = skills.map(({ manifest }) => {
    const triggered = manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase()));
    let reason: SkillSelectionReason;
    if (!triggered) reason = "trigger-mismatch";
    else if (!grantedSkills.has(manifest.id)) reason = "skill-denied";
    else if (!manifest.requiredCapabilities.every((capability) => available.has(capability))) reason = "capability-missing";
    else if (!manifest.tools.every((tool) => grantedTools.has(tool))) reason = "tool-denied";
    else reason = "selected";
    return {
      skillId: manifest.id,
      reason,
      requiredCapabilities: [...manifest.requiredCapabilities],
      declaredToolIds: [...manifest.tools],
    };
  });
  const selectedIds = new Set(decisions.filter((decision) => decision.reason === "selected").map((decision) => decision.skillId));
  const selectedSkills = skills.filter(({ manifest }) => selectedIds.has(manifest.id));
  return {
    selectedSkills,
    mountedSkillToolIds: sortedUnique(selectedSkills.flatMap(({ manifest }) => manifest.tools)),
    decisions,
  };
}

export type SkillDependencyExpansionError =
  | "unknown"
  | "dependency-missing"
  | "dependency-cycle"
  | "dependency-invalid"
  | "selection-overflow";

export interface SkillDependencyExpansion {
  /** Stable post-order: dependencies appear before the skill that requires them. */
  ids: string[];
  /** Dependencies encountered during traversal, excluding manual roots at use time. */
  dependencyIds: string[];
  error?: { reason: SkillDependencyExpansionError; skillId: string; relatedIds?: string[] };
}

/** Expand only an explicit manual selection. There is no trigger-based path
 * here. Roots retain request order; each manifest's dependencies are visited
 * in stable id order, yielding dependency-before-dependent instructions. */
export function expandSkillDependencies(
  skillIds: readonly string[],
  skills: readonly BundledSkill[],
  max = MAX_MANUAL_SKILLS,
): SkillDependencyExpansion {
  const byId = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  const ids: string[] = [];
  const dependencyIds = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  let error: SkillDependencyExpansion["error"];

  const visit = (id: string): void => {
    if (error || visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      error = { reason: "dependency-cycle", skillId: id, relatedIds: stack.slice(cycleStart) };
      return;
    }
    const skill = byId.get(id);
    if (!skill) {
      error = { reason: "unknown", skillId: id };
      return;
    }
    const dependencies = skill.manifest.dependencies ?? [];
    if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length ||
      dependencies.some((dependency) => !SAFE_ID.test(dependency) || dependency === id)) {
      error = { reason: "dependency-invalid", skillId: id };
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of [...dependencies].sort(compareDeterministically)) {
      dependencyIds.add(dependency);
      if (!byId.has(dependency)) {
        error = { reason: "dependency-missing", skillId: dependency, relatedIds: [id] };
        break;
      }
      visit(dependency);
      if (error) break;
    }
    stack.pop();
    visiting.delete(id);
    if (error) return;
    visited.add(id);
    ids.push(id);
  };

  for (const skillId of skillIds) {
    visit(skillId);
    if (error) break;
  }
  if (!error && ids.length > max) {
    error = { reason: "selection-overflow", skillId: ids[max]!, relatedIds: ids.slice(max) };
  }
  return { ids, dependencyIds: [...dependencyIds].sort(compareDeterministically), ...(error ? { error } : {}) };
}

/** Exact manual selection for one send. Trigger terms deliberately do not
 * participate: ordinary text is manual-only, and an omitted id selects
 * nothing. Grants and provider capabilities remain server-authoritative. */
export function selectExactSkill(
  skillId: string | undefined,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): SkillSelection {
  return selectExactSkills(skillId ? [skillId] : [], capabilities, skills, grants);
}

/** Exact manual selection for a bounded batch. Dependencies are expanded in
 * stable post-order; a refusal returns no selected skills, so a partial grant
 * can never produce a partial send. */
export function selectExactSkills(
  skillIds: readonly string[],
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): SkillSelection {
  const grantedSkills = new Set(effectiveSkillIds(skills, grants));
  const grantedTools = new Set(effectiveSkillToolIds(skills, grants));
  const available = new Set(capabilities);
  const roots = new Set(skillIds);
  const expansion = expandSkillDependencies(skillIds, skills);
  const decisionIds = [...new Set([
    ...(expansion.error ? skillIds : expansion.ids),
    ...expansion.ids,
    ...(expansion.error?.relatedIds ?? []),
    ...(expansion.error ? [expansion.error.skillId] : []),
  ])];
  const cycleIds = new Set(expansion.error?.reason === "dependency-cycle" ? expansion.error.relatedIds : []);
  const decisions: SkillDecision[] = decisionIds.map((skillId) => {
    const skill = skills.find(({ manifest }) => manifest.id === skillId);
    if (!skill) {
      return {
        skillId,
        reason: expansion.error?.skillId === skillId ? expansion.error.reason : "unknown",
        requiredCapabilities: [],
        declaredToolIds: [],
      };
    }
    const { manifest } = skill;
    let reason: SkillSelectionReason = roots.has(skillId) ? "selected" : "dependency";
    if (cycleIds.has(skillId)) reason = "dependency-cycle";
    else if (expansion.error?.skillId === skillId && expansion.error.reason !== "selection-overflow") reason = expansion.error.reason;
    else if (expansion.error?.reason === "selection-overflow" && skillId === expansion.error.skillId) reason = "selection-overflow";
    else if (!grantedSkills.has(skillId)) reason = "skill-denied";
    else if (!manifest.requiredCapabilities.every((capability) => available.has(capability))) reason = "capability-missing";
    else if (!manifest.tools.every((tool) => grantedTools.has(tool))) reason = "tool-denied";
    return {
      skillId,
      reason,
      requiredCapabilities: [...manifest.requiredCapabilities],
      declaredToolIds: [...manifest.tools],
    };
  });
  if (decisions.some((decision) => decision.reason !== "selected" && decision.reason !== "dependency")) {
    return { selectedSkills: [], mountedSkillToolIds: [], decisions };
  }
  const byId = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  const selectedSkills = expansion.ids.map((skillId) => byId.get(skillId)!).filter(Boolean);
  return {
    selectedSkills,
    mountedSkillToolIds: sortedUnique(selectedSkills.flatMap(({ manifest }) => manifest.tools)),
    decisions,
  };
}

/** User-authored skills are hot-loaded on each turn so a just-recorded skill
 * works without restarting the desktop app. One hand-edited broken folder is
 * isolated instead of taking down every bot turn. */
export function loadUserSkills(root: string): BundledSkill[] {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const name of names) {
    try {
      const skill = loadSkillDirectory(join(root, name), { allowMissingTools: true });
      if (skill) skills.push(skill);
    } catch {
      // The recorder always writes atomically validated folders, but people
      // are free to edit them later. A malformed edit disables only itself.
    }
  }
  return skills;
}

export function mergeSkills(bundled: readonly BundledSkill[], user: readonly BundledSkill[]): BundledSkill[] {
  const byId = new Map(bundled.map((skill) => [skill.manifest.id, skill]));
  for (const skill of user) {
    if (!byId.has(skill.manifest.id)) byId.set(skill.manifest.id, skill);
  }
  return [...byId.values()];
}

/** Remove only an imported skill from the app-wide root. The origin check and
 * real-parent check keep built-in/recorded entries and legacy bot folders out
 * of this route, including when a hostile directory is a junction/symlink. */
export function removeGlobalImportedSkill(root: string, id: string): { removed: true } | { error: string } {
  if (!SAFE_ID.test(id) || id !== basename(id)) return { error: "invalid skill id" };
  const skill = loadUserSkills(root).find((candidate) => candidate.manifest.id === id);
  if (!skill) return { error: `no imported skill named "${id}"` };
  if (skill.origin !== "imported") return { error: "only imported skills can be removed here" };
  const rootPath = resolve(root);
  const target = resolve(rootPath, id);
  if (dirname(target) !== rootPath) return { error: "invalid skill directory" };
  try {
    const targetStat = lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return { error: "skill directory is not safe to remove" };
    const realRoot = realpathSync(rootPath);
    if (realpathSync(dirname(target)) !== realRoot || dirname(realpathSync(target)) !== realRoot) {
      return { error: "skill directory is outside the app-wide library" };
    }
    rmSync(target, { recursive: true, force: false });
    return { removed: true };
  } catch {
    return { error: "skill directory could not be removed safely" };
  }
}

export function skillInstructionsFor(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grantsOrOptions: SkillGrantState & { includeRoot?: boolean } = {},
): string {
  const { includeRoot = false, ...grants } = grantsOrOptions;
  return renderSkillInstructions(selectBundledSkills(text, capabilities, skills, grants), { includeRoot });
}

export function selectBundledSkills(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): BundledSkill[] {
  return decideBundledSkills(text, capabilities, skills, grants).selectedSkills;
}

export function renderSkillInstructions(
  selected: readonly BundledSkill[],
  { includeRoot = false }: { includeRoot?: boolean } = {},
): string {
  if (!selected.length) return "";
  return selected.map(({ manifest, instructions, directory }) =>
    `\n\n<openmaus-skill id=${JSON.stringify(manifest.id)} version=${JSON.stringify(manifest.version)}${includeRoot ? ` root=${JSON.stringify(directory)}` : ""}>\n${instructions}\n</openmaus-skill>`,
  ).join("");
}
