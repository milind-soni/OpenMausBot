import { reviewedSkillSha256, type SkillRequestAction, type SkillRequestCardData } from "../../shared/skill-request";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const REVIEW: Record<SkillRequestAction, readonly [LocaleKey, LocaleKey]> = {
  create: ["skills.request.reviewEnable", "skills.request.reviewEnableRefs"],
  update: ["skills.request.reviewReplace", "skills.request.reviewReplaceRefs"],
  enable: ["skills.request.reviewTurnOn", "skills.request.reviewTurnOnRefs"],
  disable: ["skills.request.reviewTurnOff", "skills.request.reviewTurnOffRefs"],
  delete: ["skills.request.reviewDelete", "skills.request.reviewDeleteRefs"],
};
const LEGACY: Partial<Record<SkillRequestAction, LocaleKey>> = { create: "skills.request.legacyCreate", update: "skills.request.legacyUpdate" };

/**
 * Security: learned instructions render as inert plain text; the approval hash binds this exact preview to the staged
 * file.
 */
export function SkillRequestPreview({ request }: { request: SkillRequestCardData }) {
  const reviewedSha256 = reviewedSkillSha256(request);
  if (!reviewedSha256) {
    return (
      <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
        {t(LEGACY[request.action] ?? "skills.request.legacyOther")}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>
          {t(REVIEW[request.action][request.references?.length ? 1 : 0])}
        </span>
        <span className="font-mono" title={`sha256 ${reviewedSha256}`}>
          sha256 {reviewedSha256.slice(0, 8)}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-ink-secondary">{t("skills.source", { source: request.source || t("skills.sourceUnknown") })}</div>
      <pre
        tabIndex={0}
        aria-label={t("skills.fullSkill", { name: request.name })}
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {request.preview}
      </pre>
      {request.references?.map((file) => (
        <div key={file.path} className="mt-3 border-t border-hairline/40 pt-2">
          <div className="font-mono text-[11px] text-ink-secondary">{file.path}</div>
          <pre
            tabIndex={0}
            aria-label={t("skills.fullFile", { path: file.path, name: request.name })}
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
          >
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}
