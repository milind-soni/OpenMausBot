import { reviewedSkillSha256, type SkillRequestCardData } from "../../shared/skill-request";

/** Render learned instructions as inert plain text. The approval hash binds
 * this exact preview to the staged file the server will promote. */
export function SkillRequestPreview({ request }: { request: SkillRequestCardData }) {
  const reviewedSha256 = reviewedSkillSha256(request);
  if (!reviewedSha256) {
    return (
      <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
        This proposal was created by an older build and cannot be safely applied. Deny it, then ask the bot to
        {request.action === "update" ? " propose the update again." : " create the skill again."}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>
          Review the complete SKILL.md before {request.action === "update" ? "replacing the current version" : "enabling"}
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
    </div>
  );
}
