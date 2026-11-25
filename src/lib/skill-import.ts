import type { SkillImportSummary, SkippedSkillFileReason } from "../../shared/skill-import";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "./i18n";

const REASONS: Record<SkippedSkillFileReason, LocaleKey> = {
  link: "skills.import.reason.link",
  submodule: "skills.import.reason.submodule",
  hidden: "skills.import.reason.hidden",
  generated: "skills.import.reason.generated",
  name: "skills.import.reason.name",
  duplicate: "skills.import.reason.duplicate",
  deep: "skills.import.reason.deep",
  large: "skills.import.reason.large",
  full: "skills.import.reason.full",
  lfs: "skills.import.reason.lfs",
  unlisted: "skills.import.reason.unlisted",
};

const SHOWN = 3;

/** One sentence per imported skill: what came in, then what was left out and why. */
export function skillImportLines(imported: readonly SkillImportSummary[]): string[] {
  const list = (items: string[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(items);
  return imported.map((skill) => {
    const parts = [t(skill.files === 1 ? "skills.import.files.one" : "skills.import.files.other", { count: skill.files })];
    if (skill.scripts) parts.push(t(skill.scripts === 1 ? "skills.import.scripts.one" : "skills.import.scripts.other", { count: skill.scripts }));
    const arrived = t("skills.import.arrived", { name: skill.name, what: list(parts) });
    if (!skill.skippedCount) return arrived;
    const left = skill.skipped.slice(0, SHOWN).map((entry) =>
      entry.path ? t("skills.import.leftOutItem", { path: entry.path, reason: t(REASONS[entry.reason]) }) : t(REASONS[entry.reason]));
    if (skill.skippedCount > left.length) left.push(t("skills.import.leftOutMore", { count: skill.skippedCount - left.length }));
    return `${arrived} ${t("skills.import.leftOut", { list: list(left) })}`;
  });
}
