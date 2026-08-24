// Bundled skill catalog. Skills remain isolated resources so adding or
// disabling one does not require changing a provider driver. A future Skills
// UI can use the same manifests; today enabled built-ins are selected by their
// declared trigger terms and mounted capabilities.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
}

export interface BundledSkill {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value.map((item) => item.trim())
    : null;
}

export function parseSkillManifest(value: unknown, directory: string): SkillManifest {
  if (!value || typeof value !== "object") throw new Error(`${directory}/manifest.json is invalid`);
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const triggerTerms = strings(raw.triggerTerms);
  const requiredCapabilities = strings(raw.requiredCapabilities);
  if (!SAFE_ID.test(id) || id !== basename(directory)) throw new Error(`${directory}/manifest.json has an invalid id`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${directory}/manifest.json has no name`);
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error(`${directory}/manifest.json has an invalid version`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${directory}/manifest.json has no description`);
  if (typeof raw.defaultEnabled !== "boolean") throw new Error(`${directory}/manifest.json has no defaultEnabled flag`);
  if (!triggerTerms?.length) throw new Error(`${directory}/manifest.json has no trigger terms`);
  if (!requiredCapabilities) throw new Error(`${directory}/manifest.json has invalid capabilities`);
  return {
    id,
    name: raw.name.trim(),
    version: raw.version,
    description: raw.description.trim(),
    defaultEnabled: raw.defaultEnabled,
    triggerTerms,
    requiredCapabilities,
  };
}

function loadSkillDirectory(directory: string): BundledSkill | null {
  const manifestPath = join(directory, "manifest.json");
  const skillPath = join(directory, "SKILL.md");
  if (!existsSync(manifestPath) || !existsSync(skillPath)) return null;
  const manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")), directory);
  const instructions = readFileSync(skillPath, "utf8").trim();
  if (!instructions.startsWith("---")) throw new Error(`${skillPath} has no skill frontmatter`);
  return { manifest, instructions, directory };
}

export function loadBundledSkills(root = process.env.OMB_SKILLS_DIR || join(process.cwd(), "skills")): BundledSkill[] {
  if (!existsSync(root)) return [];
  const skills: BundledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const skill = loadSkillDirectory(directory);
    if (skill) skills.push(skill);
  }
  return skills;
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
      const skill = loadSkillDirectory(join(root, name));
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

export function skillInstructionsFor(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  options?: { includeRoot?: boolean },
): string {
  return renderSkillInstructions(selectBundledSkills(text, capabilities, skills), options);
}

export function selectBundledSkills(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
): BundledSkill[] {
  const haystack = text.toLowerCase();
  const available = new Set(capabilities);
  return skills.filter(({ manifest }) =>
    manifest.defaultEnabled &&
    manifest.requiredCapabilities.every((capability) => available.has(capability)) &&
    manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase())),
  );
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
