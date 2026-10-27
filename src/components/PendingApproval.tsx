import { memo, useState, type ReactNode } from "react";
import { ChevronDown, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { APPROVAL_CODE_CHIP, toolLabel } from "./ApprovalCard";
import { outboundSummary } from "@/lib/approval-summary";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

interface ApprovalLabels {
  [tool: string]: LocaleKey;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  allowKey?: string;
  allowSession?: boolean;
  commandAllowlist?: { command: string; cwd: string; providerInstanceId: string };
  detail: string;
  held?: string;
  heldCode?: string;
}

/** Security: the persisted payload is the marker; provider-authored tool names can collide with ours. */
export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

export function isSkillApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.skillRequest);
}

export function isProfileApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.profileRequest);
}

export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    // A routine card left open from before Triggers v2 can't be confirmed: trigger changes apply on their own.
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed && !m.card.expired && !m.card.routineRequest)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      allowSession: m.card!.allowSession,
      commandAllowlist: m.card!.commandAllowlist,
      detail: m.card!.subtitle,
      held: m.card!.held,
      heldCode: m.card!.heldCode,
    }));
}

export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  if (pending.message.card?.teamSetupRequest) return `${requester}: ${pending.message.card.title} Review the details and choose ${pending.message.card.options[0]} or ${pending.message.card.options[1] ?? "Cancel"}.`;
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
    const title = pending.message.card?.title.trim() || t("approval.voice.defaultUpdateProfile");
    return t("approval.voice.profile", { requester, title });
  }
  return t("approval.voice.command", { requester, tool: toolLabel(pending.tool), detail: pending.detail });
}

function label(pending: Pending): string {
  if (pending.message.card?.teamSetupRequest) return pending.message.card.title;
  if (isSkillApproval(pending)) {
    return pending.message.card?.skillRequest?.action === "update"
      ? t("approval.label.updateSkill")
      : t("approval.label.enableSkill");
  }
  if (isProfileApproval(pending)) {
    return t("approval.label.confirmProfileChange");
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

export const APPROVAL_CONTROL =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const COMMAND_TOOLS = new Set(["Bash", "shell"]);

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim();
}

function isDurable(pending: Pending): boolean {
  const card = pending.message.card;
  return isSkillApproval(pending) || isProfileApproval(pending) ||
    Boolean(card?.teamSetupRequest) || Boolean(card?.modelRequest);
}

function rowText(pending: Pending, botName?: string): { line: string; inline?: string } {
  const card = pending.message.card;
  const outbound = card ? outboundSummary(card) : undefined;
  if (outbound) return { line: outbound.headline };
  if (isDurable(pending)) return { line: label(pending) };
  const detail = firstLine(pending.commandAllowlist?.command ?? pending.detail);
  if (!botName) return { line: label(pending), inline: detail || undefined };
  if (COMMAND_TOOLS.has(pending.tool)) return { line: t("approval.compact.wantsToRun", { name: botName }), inline: detail || undefined };
  return { line: t("approval.card.namedWantsTo", { name: botName, action: toolLabel(pending.tool) }), inline: detail || undefined };
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
  botName,
  actions,
  more,
}: {
  pending: Pending;
  count: number;
  index: number;
  botName?: string;
  actions?: ReactNode;
  more?: ReactNode;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
  const heldNote = outbound?.opaque && pending.heldCode === "approval.held.outbound"
    ? t("approval.opaqueCode")
    : tFromServer(pending.heldCode, pending.held);
  const { line, inline } = rowText(pending, botName);
  const detailsId = `approval-details-${pending.requestId}`;
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
      className="px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2">
        <ShieldCheck size={16} className="shrink-0 self-center text-accent" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 basis-52 items-baseline gap-2" aria-live="polite">
          <span className="min-w-0 max-w-[60%] shrink-0 truncate text-[13px] font-medium leading-5 text-ink" title={line}>{line}</span>
          {outbound?.summary && (
            <span className="min-w-0 shrink-[4] truncate text-[13px] leading-5 text-ink-secondary" title={outbound.summary}>{outbound.summary}</span>
          )}
          {inline && (
            <code className={cn(APPROVAL_CODE_CHIP, "shrink-[4] pb-[3px] pt-[5px]")} title={inline}>
              <span className="truncate">{inline}</span>
            </code>
          )}
          {heldNote && (outbound ? (
            <span title={heldNote} className={cn(APPROVAL_CONTROL, "h-auto cursor-default items-baseline bg-warning/10 px-2.5 py-1 text-warning")}>
              <Send size={13} aria-hidden="true" className="self-center" />
              {t("approval.compact.maySend")}
            </span>
          ) : (
            <span title={heldNote} className="inline-flex shrink-0 self-center text-warning">
              <TriangleAlert size={14} aria-hidden="true" />
              <span className="sr-only">{heldNote}</span>
            </span>
          ))}
          {count > 1 && (
            <span className="shrink-0 rounded-full bg-control px-1.5 text-[11px] leading-5 tabular-nums text-ink-secondary">
              {t("approval.position", { index: index + 1, count })}
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-baseline gap-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
            title={open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
            onClick={() => setOpen((value) => !value)}
            className={cn(APPROVAL_CONTROL, "w-7 self-center px-0 text-ink-tertiary hover:bg-ink/10 hover:text-ink")}
          >
            <ChevronDown size={16} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
          </button>
          {actions}
        </div>
      </div>
      <div id={detailsId} hidden={!open} className="mt-2 space-y-2 px-0.5">
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
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-inset px-4 py-3 font-mono text-[12px] leading-relaxed text-ink"
        >
          {pending.commandAllowlist?.command ?? pending.detail}
        </pre>
        {pending.message.card?.skillRequest && (
          <SkillRequestPreview request={pending.message.card.skillRequest} />
        )}
        {heldNote && <div className="text-[12px] text-warning">{heldNote}</div>}
        {more}
      </div>
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
  part,
}: {
  pending: Pending;
  threadId: string;
  bot?: Bot;
  onCancelTurn: () => void;
  part?: "primary" | "more";
}) {
  const { dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  const isTeamSetup = Boolean(pending.message.card?.teamSetupRequest);
  const durableRequest = isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup;
  const canRememberCommand = ownerOrAdmin === true && !durableRequest && !pending.allowKey && Boolean(pending.commandAllowlist);
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const decide = (behavior: "allow" | "deny", always = false, rememberCommand = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
      always: always && !pending.allowKey && pending.allowSession ? true : undefined,
      rememberCommand: rememberCommand || undefined,
    });

  const showPrimary = part !== "more";
  const showMore = part !== "primary";
  const always = durableRequest ? null
    : bot && pending.allowKey
      ? { name: t("approval.action.alwaysAllow"), hint: t("approval.action.stopAsking", { name: bot.name, key: pending.allowKey }), run: () => decide("allow", true) }
      : canRememberCommand && pending.commandAllowlist
        ? { name: t("approval.action.alwaysAllowCommand"), hint: t("approval.action.alwaysAllowCommandHint", { cwd: pending.commandAllowlist.cwd }), run: () => decide("allow", false, true) }
        : !pending.allowKey && pending.allowSession
          ? { name: t("approval.action.alwaysAllowSession"), hint: t("approval.action.alwaysAllowSessionHint"), run: () => decide("allow", true) }
          : null;
  const more = showMore && !durableRequest ? [
    <button key="cancel" type="button" onClick={onCancelTurn} className={cn(APPROVAL_CONTROL, "bg-ink/[0.07] text-ink-secondary hover:bg-ink/[0.12] hover:text-ink")}>
      {t("approval.action.cancelTurn")}
    </button>,
  ] : [];
  const primary = showPrimary ? [
    <button
      key="deny"
      type="button"
      onClick={() => decide("deny")}
      autoFocus={isTeamSetup}
      className={cn(APPROVAL_CONTROL, "bg-ink/[0.07] text-danger hover:bg-danger/15")}
    >
      {isRoutineRequest || isProfileRequest || isTeamSetup ? t("approval.action.cancel") : t("approval.action.deny")}
    </button>,
    always && (
      <button
        key="always"
        type="button"
        onClick={always.run}
        aria-label={always.name}
        title={always.hint}
        className={cn(APPROVAL_CONTROL, "bg-ink/[0.07] text-ink hover:bg-ink/[0.12]")}
      >
        {t("approval.action.alwaysAllow")}
      </button>
    ),
    <button
      key="allow"
      type="button"
      onClick={() => decide("allow")}
      disabled={isSkillRequest && !reviewedSha256}
      className={cn(APPROVAL_CONTROL, "bg-accent text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40")}
    >
      {isTeamSetup ? pending.message.card?.options[0] : isSkillRequest
        ? pending.message.card?.skillRequest?.action === "update"
          ? t("approval.action.update")
          : t("approval.action.enable")
        : isRoutineRequest || isProfileRequest
          ? t("approval.action.confirm")
          : t("approval.action.allowOnce")}
    </button>,
  ].filter(Boolean) : [];
  if (part === "primary") return <>{primary}</>;
  if (part === "more") return more.length ? <div className="flex flex-wrap items-center gap-2">{more}</div> : null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {more}
      {primary}
    </div>
  );
}
