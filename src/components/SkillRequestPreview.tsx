import { reviewedSkillSha256, type SkillRequestCardData } from "../../shared/skill-request";
import { t } from "@/lib/i18n";


/**
 * Security: learned instructions render as inert plain text; the approval hash binds this exact preview to the staged
 * file.
 */
export function SkillRequestPreview({ request }: { request: SkillRequestCardData }) {
  const reviewedSha256 = reviewedSkillSha256(request);
  if (!reviewedSha256) {
    return (
      <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
        {t(request.action === "update" ? "ui.skillRequestPreview.thisProposalWasCreatedByAnOlderBuildAndCannot" : "ui.skillRequestPreview.thisProposalWasCreatedByAnOlderBuildAndCannot2")}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>
          {t(request.action === "update" ? "ui.skillRequestPreview.reviewTheCompleteSKILLMdReferencesBeforeReplacingTheCurrent" : "ui.skillRequestPreview.reviewTheCompleteSKILLMdReferencesBeforeEnabling", { references: request.references?.length ? t("ui.skillRequestPreview.andItsReferenceFiles") : "" })}
        </span>
        <span className="font-mono" title={`sha256 ${reviewedSha256}`}>
          sha256 {reviewedSha256.slice(0, 8)}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-ink-secondary">{t("ui.skillRequestPreview.source")} {request.source || t("ui.skillRequestPreview.unknown")}</div>
      <pre
        tabIndex={0}
        aria-label={t("ui.skillRequestPreview.fullSKILLMdForName", { name: request.name })}
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {request.preview}
      </pre>
      {request.references?.map((file) => (
        <div key={file.path} className="mt-3 border-t border-hairline/40 pt-2">
          <div className="font-mono text-[11px] text-ink-secondary">{file.path}</div>
          <pre
            tabIndex={0}
            aria-label={t("ui.skillRequestPreview.fullPathForName", { path: file.path, name: request.name })}
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
          >
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}
