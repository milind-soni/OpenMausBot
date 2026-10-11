// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
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
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  allowSession?: boolean;
  commandAllowlist?: { command: string; cwd: string; providerInstanceId: string };
  detail: string;
  held?: string;
  heldCode?: string;
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
    // An expired proposal is terminal: it must not take over the composer
    // or offer its decision buttons anywhere.
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed && !m.card.expired)
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

/** Routine cards can carry every instruction the user asked for (up to
 * 20,000 characters). Calls should announce the concise, visible title and
 * let the user review those details on screen instead of reading them all. */
export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  if (pending.message.card?.teamSetupRequest) return `${requester}: ${pending.message.card.title} Review the details and choose ${pending.message.card.options[0]} or ${pending.message.card.options[1] ?? "Cancel"}.`;
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
    // pending.tool can be an ACP toolCall kind rather than a tool name —
    // speak the same verb phrase the card header shows, so voice never
    // reads "wants to other".
    return t("approval.voice.command", { requester, tool: toolLabel(pending.tool), detail: pending.detail });
  }
  const title = pending.message.card?.title.trim() || t("approval.voice.defaultConfirmRoutine");
  return t("approval.voice.routine", {
    requester,
    title: `${title}${/[.!?]$/.test(title) ? "" : "."}`,
  });
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

/** One look for every button and chip in the approval row: 28px tall,
 * 13px medium text centred with room for Arabic and other scripts that
 * reach below the baseline, icon and text on one line with one gap. */
export const APPROVAL_CONTROL =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const COMMAND_TOOLS = new Set(["Bash", "shell"]);

/** The first line of a request, for the one-line row. The whole of it is
 * one tap away under the chevron. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim();
}

function isDurable(pending: Pending): boolean {
  const card = pending.message.card;
  return isSkillApproval(pending) || isRoutineApproval(pending) || isProfileApproval(pending) ||
    Boolean(card?.teamSetupRequest) || Boolean(card?.modelRequest);
}

/** What the row says, and the short inline monospace text after it. */
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

/** The pending approval above the composer: one row with what is asked
 * and the answers. Everything else (the full request, why it asks, Cancel
 * turn) opens under the chevron. */
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
  /** who is asking, for "Dev wants to run git status" */
  botName?: string;
  /** Deny and Allow once, on the row. */
  actions?: ReactNode;
  /** Cancel turn, under the chevron. */
  more?: ReactNode;
  /** The active locale. Not read here: it is the memo key, the same way the
   * transcript takes one. Every line in this panel comes from the catalog,
   * and nothing else about a pending approval changes with the language. */
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  // A held outbound action names where it sends and what, not its slug.
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
  // Code is held because nothing can tell what it will send, not because it
  // is known to send. Say that, rather than "This sends something".
  const heldNote = outbound?.opaque && pending.heldCode === "approval.held.outbound"
    ? t("approval.held.code")
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
      {/* One line at normal widths. When the pane is narrow the answers
          drop under the text instead of squeezing it. Items line up on
          the text baseline, icons on the center. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2">
        {/* centered on the row, so a mono chip's metrics never move it */}
        <ShieldCheck size={16} className="shrink-0 self-center text-accent" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 basis-52 items-baseline gap-2" aria-live="polite">
          {/* the short label keeps its words; a long command gives way first */}
          <span className="min-w-0 max-w-[60%] shrink-0 truncate text-[13px] font-medium leading-5 text-ink" title={line}>{line}</span>
          {outbound?.summary && (
            <span className="min-w-0 shrink-[4] truncate text-[13px] leading-5 text-ink-secondary" title={outbound.summary}>{outbound.summary}</span>
          )}
          {/* 28px like the buttons: 2px more on each side of the 24px pill */}
          {inline && (
            <code className={cn(APPROVAL_CODE_CHIP, "shrink-[4] pb-[3px] pt-[5px]")} title={inline}>
              <span className="truncate">{inline}</span>
            </code>
          )}
          {heldNote && (outbound ? (
            // the reason it asks, as a marker; the sentence is in its tooltip
            // and under the chevron
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
        {/* never truncated here — long commands wrap and scroll */}
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
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-3xl bg-inset px-4 py-3 font-mono text-[12px] leading-relaxed text-ink"
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
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
  /** "primary": Deny, the one "always" grant that applies, and Allow once,
   * for the row. "more": Cancel turn, for the details. Both when omitted. */
  part?: "primary" | "more";
}) {
  const { dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  const isTeamSetup = Boolean(pending.message.card?.teamSetupRequest);
  const isSuggestion = Boolean(pending.message.card?.teamSetupRequest?.suggestion);
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
      // a harness-native card (peer comms) remembers a grant on the bot; a
      // provider's card hands the allow to the provider for its session
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
      always: always && !pending.allowKey && pending.allowSession ? true : undefined,
      rememberCommand: rememberCommand || undefined,
    });

  const showPrimary = part !== "more";
  const showMore = part !== "primary";
  // At most one "always" grant applies, and each is an existing one: a
  // harness-native card remembers its allowKey on the bot, an exact shell
  // command goes to the command allowlist, a provider (or a chat tool,
  // #2484) keeps a session allow. Held sends and app code carry none of
  // these, so they never offer it. The button says "Always allow"; its
  // name and tooltip say exactly what is remembered.
  const always = durableRequest ? null
    : bot && pending.allowKey
      ? { name: t("approval.action.alwaysAllow"), hint: t("approval.action.stopAsking", { name: bot.name, key: pending.allowKey }), run: () => decide("allow", true) }
      : canRememberCommand && pending.commandAllowlist
        ? { name: t("approval.action.alwaysAllowCommand"), hint: t("approval.action.alwaysAllowCommandHint", { cwd: pending.commandAllowlist.cwd }), run: () => decide("allow", false, true) }
        : !pending.allowKey && pending.allowSession
          ? { name: t("approval.action.alwaysAllowSession"), hint: t("approval.action.alwaysAllowSessionHint"), run: () => decide("allow", true) }
          : null;
  // Stopping the whole turn is the rare way out, so it lives with the
  // details, away from the answers.
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
      {isSuggestion ? t("approval.action.notNow") : isRoutineRequest || isProfileRequest || isTeamSetup ? t("approval.action.cancel") : t("approval.action.deny")}
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
