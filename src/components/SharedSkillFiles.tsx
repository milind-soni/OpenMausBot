import { t } from "@/lib/i18n";
import { sharedSkillFiles, type SharedSkillFile } from "@/lib/skill-files";
import type { PackageDocument } from "../../shared/package-format";

export function SkillFileList({ files }: { files: readonly SharedSkillFile[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-3 text-[13px] text-ink-secondary">
      <div className="font-medium text-ink">{t("teamShare.skillFiles")}</div>
      <ul className="mt-1 list-disc pl-5">
        {files.map((file) => <li key={`${file.skill}/${file.path}`} className="break-all">
          {file.content === undefined ? <>{file.skill} · {file.path} · {t("teamShare.binarySkillFile")}</> : (
            <details>
              <summary className="cursor-pointer">{file.skill} · {file.path}{file.executable ? ` · ${t("teamShare.executableSkillFile")}` : ""}</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-2 text-[12px]">{file.content}</pre>
            </details>
          )}
        </li>)}
      </ul>
    </div>
  );
}

export function SharedSkillFiles({ document }: { document: PackageDocument }) {
  return <SkillFileList files={sharedSkillFiles(document)} />;
}
