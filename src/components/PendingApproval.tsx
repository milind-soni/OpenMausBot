// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { reviewedSkillSha256 } from "../../shared/skill-request";

interface ApprovalLabels {
  [tool: string]: LocaleKey;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  detail: string;
  held?: string;
}

/** The persisted payload is the authoritative marker. Tool names are
 * provider-authored display strings and can collide with ours. */
export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

export function isSkillApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.skillRequest);
}

export function isProfileApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.profileRequest);
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
    }));
}

/** Routine cards can carry every instruction the user asked for (up to
 * 20,000 characters). Calls should announce the concise, visible title and
 * let the user review those details on screen instead of reading them all. */
export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  if (isSkillRequest) {
    const updating = pending.message.card?.skillRequest?.action === "update";
    const title = pending.message.card?.title.trim() || t(
      updating ? "approval.voice.defaultUpdateSkill" : "approval.voice.defaultEnableSkill",
    );
    return t("approval.voice.skill", {
      requester,
      title: `${title}${/[.!?]$/.test(title) ? "" : "."}`,
      action: t(updating ? "approval.voice.actionUpdate" : "approval.voice.actionEnable"),
    });
  }
  if (isProfileRequest) {
    // pending.detail is the full subtitle — the whole diff for a soul
    // change. Speak the card's concise title instead, the same way the
    // routine/skill branches do, and let the user read the diff on screen.
    const title = pending.message.card?.title.trim() || t("approval.voice.defaultUpdateProfile");
    return t("approval.voice.profile", { requester, title });
  }
  if (!isRoutineRequest) {
    return t("approval.voice.command", { requester, tool: pending.tool, detail: pending.detail });
  }
  const title = pending.message.card?.title.trim() || t("approval.voice.defaultConfirmRoutine");
  return t("approval.voice.routine", {
    requester,
    title: `${title}${/[.!?]$/.test(title) ? "" : "."}`,
  });
}

function label(pending: Pending): string {
  if (isSkillApproval(pending)) {
    return pending.message.card?.skillRequest?.action === "update"
      ? t("approval.label.updateSkill")
      : t("approval.label.enableSkill");
  }
  if (isProfileApproval(pending)) {
    return t("approval.label.confirmProfileChange");
  }
  if (isRoutineApproval(pending)) {
    return pending.message.card?.routineRequest?.operation.action === "create"
      ? t("approval.label.confirmRoutine")
      : t("approval.label.confirmRoutineChange");
  }
  const nice: ApprovalLabels = {
    Bash: "approval.label.commandRequested",
    shell: "approval.label.commandRequested",
    Read: "approval.label.fileReadRequested",
    Write: "approval.label.fileChangeRequested",
    Edit: "approval.label.fileChangeRequested",
    edit: "approval.label.fileChangeRequested",
  };
  const key = nice[pending.tool];
  return key ? t(key) : t("approval.label.requested");
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
}: {
  pending: Pending;
  count: number;
  index: number;
}) {
  return (
    <div
      role="region"
      aria-label={
        isSkillApproval(pending)
          ? t("approval.aria.pendingSkill")
          : isRoutineApproval(pending)
            ? t("approval.aria.pendingRoutine")
            : isProfileApproval(pending)
              ? t("approval.aria.pendingProfile")
              : t("approval.aria.pending")
      }
      className="rounded-t-2xl border-b border-hairline/50 bg-control/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">
          {t("approval.pending")}
        </span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {t("approval.position", { index: index + 1, count })}
          </span>
        )}
        <span className="text-[13px] text-ink">{label(pending)}</span>
        <span className="font-mono text-[11px] text-ink-secondary">
          {isSkillApproval(pending)
            ? pending.message.card?.skillRequest?.action === "update" ? "update_skill" : "stage_skill"
            : isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.operation.action === "create"
              ? "schedule_routine"
              : "manage_routine"
            : isProfileApproval(pending)
              ? "update_profile"
              : pending.tool}
        </span>
      </div>
      {/* never truncated — long commands wrap and scroll */}
      <pre
        tabIndex={0}
        aria-label={
          isSkillApproval(pending)
            ? t("approval.aria.reviewSkill")
            : isRoutineApproval(pending)
              ? t("approval.aria.reviewRoutine")
              : isProfileApproval(pending)
                ? t("approval.aria.reviewProfile")
                : t("approval.aria.reviewDetails")
        }
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {pending.detail}
      </pre>
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      {pending.held && <div className="mt-2 text-[12px] text-warning">{pending.held}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
}) {
  const { dispatch } = useStore();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest || isProfileRequest;
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-2 py-2">
      {!durableRequest && (
        <button onClick={onCancelTurn} className={cn(base, "text-ink-secondary hover:bg-control hover:text-ink")}>
          {t("approval.action.cancelTurn")}
        </button>
      )}
      <button
        onClick={() => decide("deny")}
        className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
      >
        {isRoutineRequest || isProfileRequest ? t("approval.action.cancel") : t("approval.action.deny")}
      </button>
      {!durableRequest && bot && pending.allowKey && (
        <button
          onClick={() => decide("allow", true)}
          title={t("approval.action.stopAsking", { name: bot.name, key: pending.allowKey })}
          className={cn(base, "border border-hairline/50 text-ink hover:bg-control")}
        >
          {t("approval.action.alwaysAllow")}
        </button>
      )}
      <button
        onClick={() => decide("allow")}
        disabled={isSkillRequest && !reviewedSha256}
        className={cn(
          base,
          "bg-accent font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        {isSkillRequest
          ? pending.message.card?.skillRequest?.action === "update"
            ? t("approval.action.update")
            : t("approval.action.enable")
          : isRoutineRequest || isProfileRequest
            ? t("approval.action.confirm")
            : t("approval.action.allowOnce")}
      </button>
    </div>
  );
}
