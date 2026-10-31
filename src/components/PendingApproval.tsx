import { memo, useState, type ReactNode } from "react";
import { ChevronDown, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { toolLabel } from "./ApprovalCard";
import { ASK_QUIET_ANSWER, ASK_QUIET_BUTTON, ASK_SECONDARY_BUTTON, AskDetail, AskHeader, askPrimary, type Asker } from "./AskCard";
import { outboundSummary } from "@/lib/approval-summary";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useInboxOrigin } from "./InboxLine";
import { yourComputerAsk } from "@/lib/your-computer";
import { computerAskWords } from "@/lib/computer-ask";
import { DESKTOP_DOWNLOAD_URL } from "../../shared/computer-ask";

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
  const turnOn = computerAskWords(pending.message.card, requester);
  if (turnOn) return `${turnOn.line}. ${turnOn.reason}`;
  const ask = yourComputerAsk(pending.message.card, requester);
  if (ask) return `${requester}: ${ask.line}`;
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

const COMMAND_TOOLS = new Set(["Bash", "shell"]);

function isDurable(pending: Pending): boolean {
  const card = pending.message.card;
  return isSkillApproval(pending) || isProfileApproval(pending) ||
    Boolean(card?.teamSetupRequest) || Boolean(card?.modelRequest);
}

/** What will happen, in plain words; the command shown whole when it is what will run, and everything the card holds
 * behind Details. */
function approvalWords(pending: Pending, botName?: string): { line: string; summary?: string; inline?: string; note?: string; detail: string } {
  const card = pending.message.card;
  const outbound = card ? outboundSummary(card) : undefined;
  const turnOn = computerAskWords(card, botName ?? t("approval.someone"));
  if (turnOn) return { line: turnOn.line, summary: turnOn.why ?? turnOn.reason, ...(turnOn.why ? { note: turnOn.reason } : {}), detail: "" };
  const ask = yourComputerAsk(card, botName ?? t("approval.someone"));
  const detail = (pending.commandAllowlist?.command ?? ask?.detail ?? pending.detail).trim();
  if (outbound) return { line: outbound.headline, ...(outbound.summary ? { summary: outbound.summary } : {}), detail };
  if (ask) return { line: ask.line, detail };
  if (isDurable(pending)) return { line: label(pending), detail };
  const action = COMMAND_TOOLS.has(pending.tool) ? t("approval.tool.runCommand") : toolLabel(pending.tool);
  return { line: botName ? t("approval.card.namedWantsTo", { name: botName, action }) : label(pending), inline: detail, detail };
}

/** An inbox's copy names the conversation it was asked in, as the way back there. */
function CopyHeader({ message, asker, line }: { message: Message; asker: Asker; line: string }) {
  return <AskHeader asker={asker} line={line} origin={useInboxOrigin(message)} />;
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
  botName,
  asker,
  actions,
  more,
}: {
  pending: Pending;
  count: number;
  index: number;
  botName?: string;
  /** The bot that asks, whose face leads the card. */
  asker?: Asker;
  actions?: ReactNode;
  more?: ReactNode;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
  const heldNote = outbound?.opaque && pending.heldCode === "approval.held.outbound"
    ? t("approval.opaqueCode")
    : tFromServer(pending.heldCode, pending.held);
  const { line, summary, inline, note, detail } = approvalWords(pending, botName ?? asker?.name);
  const detailsId = `approval-details-${pending.requestId}`;
  const hidden = detail && detail !== inline ? detail : "";
  const skill = pending.message.card?.skillRequest;
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
      data-ask-card="approval"
      className="px-4 pb-3.5 pt-3"
    >
      <div className="flex min-w-0 items-center gap-2" aria-live="polite">
        <div className="min-w-0 flex-1">
          {asker ? pending.message.inbox?.origin ? <CopyHeader message={pending.message} asker={asker} line={line} /> : <AskHeader asker={asker} line={line} /> : (
            <div className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink-secondary">
              <ShieldCheck size={15} className="shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{line}</span>
            </div>
          )}
        </div>
        {count > 1 && (
          <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 text-[12px] leading-5 tabular-nums text-ink-secondary">
            {t("approval.position", { index: index + 1, count })}
          </span>
        )}
        {(hidden || skill || more) && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
            title={open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
            onClick={() => setOpen((value) => !value)}
            className={cn(ASK_QUIET_BUTTON, "-me-2 w-7 px-0")}
          >
            <ChevronDown size={16} aria-hidden="true" className={cn("motion-safe:transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>
      {summary && <p dir="auto" className="mt-1.5 break-words text-[15px] font-medium leading-[22px] text-ink">{summary}</p>}
      {inline && <AskDetail text={inline} mono label={t("approval.aria.reviewDetails")} />}
      {note && <p dir="auto" data-computer-ask-reason className="mt-1 break-words text-[13px] leading-[18px] text-ink-secondary">{note}</p>}
      {heldNote && (outbound ? (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] leading-[18px] text-warning">
          <Send size={13} aria-hidden="true" className="shrink-0" />
          <span title={heldNote}>{t("approval.compact.maySend")}</span>
        </p>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-[18px] text-warning">
          <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{heldNote}</span>
        </p>
      ))}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{actions}</div>
      <div id={detailsId} hidden={!open} className="mt-3 space-y-2">
        {hidden && (
          <pre tabIndex={0} aria-label={t("approval.aria.reviewDetails")}
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ink/[0.045] px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-secondary">
            {hidden}
          </pre>
        )}
        {skill && <SkillRequestPreview request={skill} />}
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
  tag,
}: {
  pending: Pending;
  threadId: string;
  bot?: Bot;
  onCancelTurn: () => void;
  part?: "primary" | "more";
  /** Marks each answer for the surface that shows it, as data-<tag>-action. */
  tag?: string;
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

  const allow = askPrimary(bot?.color);
  const marked = (action: string) => (tag ? { [`data-${tag}-action`]: action } : {});
  const showPrimary = part !== "more";
  const showMore = part !== "primary";
  const turnOn = computerAskWords(pending.message.card, bot?.name ?? t("approval.someone"));
  if (turnOn) {
    if (!showPrimary) return null;
    return (
      <>
        {turnOn.getApp && (
          <a key="get" {...marked("get-app")} href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" className={ASK_SECONDARY_BUTTON}>{turnOn.getApp}</a>
        )}
        <button key="deny" {...marked("deny")} type="button" onClick={() => decide("deny")} className={turnOn.turnOn ? ASK_SECONDARY_BUTTON : ASK_QUIET_ANSWER}>
          {t("computerAsk.action.notNow")}
        </button>
        {turnOn.turnOn && (
          <button key="allow" {...marked("allow")} type="button" onClick={() => decide("allow")} className={allow.className} style={allow.style}>{turnOn.turnOn}</button>
        )}
      </>
    );
  }
  const always = durableRequest ? null
    : bot && pending.allowKey
      ? { name: t("approval.action.alwaysAllow"), hint: t("approval.action.stopAsking", { name: bot.name, key: pending.allowKey }), run: () => decide("allow", true) }
      : canRememberCommand && pending.commandAllowlist
        ? { name: t("approval.action.alwaysAllowCommand"), hint: t("approval.action.alwaysAllowCommandHint", { cwd: pending.commandAllowlist.cwd }), run: () => decide("allow", false, true) }
        : !pending.allowKey && pending.allowSession
          ? { name: t("approval.action.alwaysAllowSession"), hint: t("approval.action.alwaysAllowSessionHint"), run: () => decide("allow", true) }
          : null;
  const more = showMore && !durableRequest ? [
    <button key="cancel" type="button" onClick={onCancelTurn} className={ASK_QUIET_ANSWER}>
      {t("approval.action.cancelTurn")}
    </button>,
  ] : [];
  const primary = showPrimary ? [
    always && (
      <button
        key="always"
        type="button"
        onClick={always.run}
        aria-label={always.name}
        title={always.hint}
        className={ASK_QUIET_ANSWER}
      >
        {t("approval.action.alwaysAllow")}
      </button>
    ),
    <button
      key="deny"
      {...marked("deny")}
      type="button"
      onClick={() => decide("deny")}
      autoFocus={isTeamSetup}
      className={ASK_SECONDARY_BUTTON}
    >
      {isRoutineRequest || isProfileRequest || isTeamSetup ? t("approval.action.cancel") : t("approval.action.deny")}
    </button>,
    <button
      key="allow"
      {...marked("allow")}
      type="button"
      onClick={() => decide("allow")}
      disabled={isSkillRequest && !reviewedSha256}
      className={allow.className}
      style={allow.style}
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
