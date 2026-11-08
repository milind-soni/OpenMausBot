import { parseSkillMd, scanSkillText } from "../shared/skill-md.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { botSkillTemplateSchema } from "./new-bot-defaults.ts";
import { portableSkillFilesFromMemory } from "./portable-skill-files.ts";
import { skillFileText } from "./skill-folder.ts";
import type { FetchedSkill } from "./skill-fetch.ts";

export function defaultSkillTemplates(fetched: readonly FetchedSkill[]) {
  const skills = [];
  for (const skill of fetched) {
    const main = skill.files.find((file) => file.path === "SKILL.md");
    if (!main) continue;
    const text = skillFileText(main.content);
    if (text === null) return { error: "SKILL.md is not UTF-8 text" };
    const parsed = parseSkillMd(text);
    if ("error" in parsed) return { error: parsed.error };
    const companions = portableSkillFilesFromMemory(skill.files);
    const omittedFiles = [...companions.skipped, ...skill.skipped.map((file) => ({
      path: redactSecretsInText(file.path || "folder contents unavailable").slice(0, 512), reason: "skill_file_unsafe" as const,
    }))].slice(0, 200);
    const skippedWarnings = omittedFiles.map((file) => `${file.path} was left out of this preset skill`);
    const template = botSkillTemplateSchema.safeParse({ name: parsed.name, description: parsed.description, source: skill.source, text,
      enabled: false, warnings: [...scanSkillText(text), ...companions.files.flatMap((file) => scanSkillText(file.content).map((warning) => `${file.path}: ${warning}`)), ...skippedWarnings].slice(0, 100),
      ...(companions.files.length ? { files: companions.files } : {}), ...(omittedFiles.length ? { omittedFiles } : {}) });
    if (!template.success) return { error: template.error.message };
    skills.push(template.data);
  }
  return { skills };
}
