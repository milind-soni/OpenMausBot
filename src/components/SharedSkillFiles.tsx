import { t } from "@/lib/i18n";
import type { PackageDocument } from "../../shared/package-format";

export function SharedSkillFiles({ document }: { document: PackageDocument }) {
  const files = (document.package.skills?.entries ?? []).flatMap((skill) =>
    (skill.files ?? []).map((file) => ({ skill: skill.name, path: file.path })));
  if (!files.length) return null;
  return (
    <div className="mt-3 text-[13px] text-ink-secondary">
      <div className="font-medium text-ink">{t("teamShare.skillFiles")}</div>
      <ul className="mt-1 list-disc pl-5">
        {files.map((file) => <li key={`${file.skill}/${file.path}`} className="break-all">{file.skill} · {file.path}</li>)}
      </ul>
    </div>
  );
}
