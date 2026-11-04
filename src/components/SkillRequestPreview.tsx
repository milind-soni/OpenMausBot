import { reviewedSkillSha256, type SkillRequestAction, type SkillRequestCardData } from "../../shared/skill-request";

const REVIEW_BEFORE: Record<SkillRequestAction, string> = {
  create: "enabling",
  update: "replacing the current version",
  enable: "turning it on",
  disable: "turning it off",
  delete: "deleting it",
};

/**
 * Security: learned instructions render as inert plain text; the approval hash binds this exact preview to the staged
 * file.
 */
export function SkillRequestPreview({ request }: { request: SkillRequestCardData }) {
  const reviewedSha256 = reviewedSkillSha256(request);
  if (!reviewedSha256) {
    return (
      <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
        This proposal was created by an older build and cannot be safely applied. Deny it, then ask the bot to
        {request.action === "create" ? " create the skill again." : request.action === "update" ? " propose the update again." : " ask again."}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>
          Review the complete SKILL.md{request.references?.length ? " and its reference files" : ""} before {REVIEW_BEFORE[request.action]}
        </span>
        <span className="font-mono" title={`sha256 ${reviewedSha256}`}>
          sha256 {reviewedSha256.slice(0, 8)}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-ink-secondary">Source: {request.source || "Unknown"}</div>
      <pre
        tabIndex={0}
        aria-label={`Full SKILL.md for ${request.name}`}
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {request.preview}
      </pre>
      {request.references?.map((file) => (
        <div key={file.path} className="mt-3 border-t border-hairline/40 pt-2">
          <div className="font-mono text-[11px] text-ink-secondary">{file.path}</div>
          <pre
            tabIndex={0}
            aria-label={`Full ${file.path} for ${request.name}`}
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
          >
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}
