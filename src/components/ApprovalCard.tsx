import { useContext, useState, type ReactNode } from "react";
import { Check, Clock3, ShieldCheck, Undo2, X } from "lucide-react";
import { api, ApiError, StoreContext, type Bot, type Message, type OptionCardData } from "@/state/store";
import { shareLearnedSkillsMode } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { composioActionPhrase, outboundSummary } from "@/lib/approval-summary";
import { niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import { cronScheduleLabel } from "../../shared/cron-label";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestField } from "../../shared/profile-request";
import type { RoutineRequestSchedule } from "../../shared/routine-request";
import type { SkillShareRecord } from "../../shared/skill-request";
import { cardAutomation } from "@/lib/automations";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { yourComputerAsk } from "@/lib/your-computer";
import { computerAskWords } from "@/lib/computer-ask";
import { TriggerCard } from "./TriggerCard";
import { CardHint } from "./CardHint";

interface ToolLabels {
  [tool: string]: LocaleKey;
}

const ROUTINE_SETTLED_LABEL = {
  create: "approval.status.routineScheduled",
  update: "approval.status.routineUpdated",
  pause: "approval.status.routinePaused",
  resume: "approval.status.routineResumed",
  run_now: "approval.status.routineRunQueued",
  delete: "approval.status.routineDeleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "approval.status.skillEnabled",
  update: "approval.status.skillUpdated",
} as const;

/** Schedules and webhooks alike are "automations" to a person. */
const AUTOMATION_APPLIED_LINE = {
  create: "approval.applied.automation.create",
  update: "approval.applied.automation.update",
  pause: "approval.applied.automation.pause",
  resume: "approval.applied.automation.resume",
  run_now: "approval.applied.automation.runNow",
  delete: "approval.applied.automation.delete",
} as const;
const WAIT_APPLIED_LINE = {
  waiting: "approval.applied.wait",
  fired: "approval.applied.waitFired",
  expired: "approval.applied.waitExpired",
  cancelled: "approval.applied.waitCancelled",
} as const;

const SKILL_APPLIED_LINE = {
  create: "approval.applied.skill.create",
  update: "approval.applied.skill.update",
} as const;

const PROFILE_FIELD_LABEL: Record<ProfileRequestField, LocaleKey> = {
  name: "approval.applied.field.name",
  title: "approval.applied.field.title",
  description: "approval.applied.field.description",
  soul: "approval.applied.field.soul",
  cwd: "approval.applied.field.cwd",
  notifications: "approval.applied.field.notifications",
  speakReplies: "approval.applied.field.speakReplies",
};

/** A routine card no one answered is from before Triggers v2 applied changes on their own: nothing can confirm it now. */
const staleRoutineCard = (card: OptionCardData) => Boolean(card.routineRequest && !card.answered);

export function approvalCardOutcome(card: OptionCardData): string | undefined {
  const isProposal = Boolean(card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest || card.teamSetupRequest);
  if (card.expired === true || staleRoutineCard(card)) return t(isProposal || !card.tool ? "approval.status.expired" : "approval.status.timedOut");
  if (!card.answered) return undefined;
  if (card.undone === true) return t("approval.status.undone");
  if (card.answered !== "allow") return isProposal ? t("approval.status.cancelled") : t("approval.status.denied");
  if (card.teamSetupRequest) return card.teamSetupRequest.deletion ? "Bot deleted" : "Team setup applied";
  const routineAction = card.routineRequest?.operation.action;
  if (routineAction) return t(ROUTINE_SETTLED_LABEL[routineAction]);
  const skillAction = card.skillRequest?.action;
  if (skillAction) return t(SKILL_SETTLED_LABEL[skillAction]);
  if (card.profileRequest) return t("approval.status.profileUpdated");
  if (card.modelRequest) return t("approval.status.modelChanged");
  if (card.routineRequest) return t("approval.status.routineConfirmed");
  if (card.skillRequest) return t("approval.status.skillConfirmed");
  return t("approval.status.allowed");
}

export function toolLabel(tool?: string): string {
  if (!tool) return t("approval.tool.takeAction");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "approval.tool.runCommand",
    Read: "approval.tool.readFile",
    Write: "approval.tool.writeFile",
    Edit: "approval.tool.editFile",
    WebFetch: "approval.tool.fetchWebPage",
    WebSearch: "approval.tool.searchWeb",
    schedule_routine: "approval.tool.scheduleRoutine",
    manage_routine: "approval.tool.changeRoutine",
    stage_skill: "approval.tool.enableSkill",
    update_skill: "approval.tool.updateSkill",
    update_profile: "approval.tool.updateProfile",
    // ACP drivers may send the protocol's toolCall kind as the tool, so every kind maps to a phrase ("shell" is
    // execute; "tool" is no kind at all).
    shell: "approval.tool.runCommand",
    edit: "approval.tool.editFile",
    read: "approval.tool.readFile",
    fetch: "approval.tool.fetchWebPage",
    delete: "approval.tool.deleteFile",
    think: "approval.tool.think",
    other: "approval.tool.takeAction",
    tool: "approval.tool.useTool",
  };
  const key = nice[tool];
  if (key) return t(key);
  return composioActionPhrase(tool.replace(/^mcp__[^_]+__/, "")) ?? bare;
}

function plainWhen(schedule: RoutineRequestSchedule): string {
  if (schedule.type === "once") {
    return new Date(schedule.at).toDateString() === new Date().toDateString()
      ? t("approval.applied.today", { time: niceTime(schedule.at) })
      : `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  }
  if (schedule.type === "cron") {
    const label = cronScheduleLabel(schedule);
    return label.startsWith("Cron ") ? "" : label;
  }
  if (schedule.type === "interval") return scheduleLabel({ ...schedule, anchorAt: schedule.anchorAt ?? 0 });
  if (schedule.type === "limit_reset") return scheduleLabel({ ...schedule, at: null });
  return scheduleLabel(schedule);
}

export function appliedChange(card: OptionCardData, name: string): { line: string; canUndo: boolean; cancels?: boolean } | undefined {
  const routine = card.routineRequest;
  if (routine) {
    const operation = routine.operation;
    const undo = routine.undo;
    const when = undo?.schedule && operation.action !== "pause" && operation.action !== "delete" && operation.action !== "run_now"
      ? plainWhen(undo.schedule)
      : "";
    const title = [
      undo?.name ?? (operation.action === "create" ? operation.routine.name : ""),
      operation.forBot ? t("approval.applied.forBot", { target: `@${operation.forBot.name}` }) : "",
    ].filter(Boolean).join(" · ") + (when ? `, ${when}` : "");
    const canUndo = operation.action === "create" ? Boolean(routine.resultId)
      : operation.action === "update" ? Boolean(undo?.before && undo.appliedUpdatedAt !== undefined)
        : operation.action === "pause" || operation.action === "resume" ? undo?.appliedUpdatedAt !== undefined
          : operation.action === "delete" ? Boolean(undo?.before)
            : false;
    return { line: t(AUTOMATION_APPLIED_LINE[operation.action], { name, title }), canUndo };
  }
  const wait = card.waitRequest;
  if (wait) return { line: t(WAIT_APPLIED_LINE[wait.settled ?? "waiting"], { name, title: wait.label }), canUndo: !wait.settled, cancels: true };
  const webhook = card.webhookRequest;
  if (webhook) {
    const target = webhook.operation.forBot ? ` · ${t("approval.applied.forBot", { target: `@${webhook.operation.forBot.name}` })}` : "";
    return { line: t(AUTOMATION_APPLIED_LINE[webhook.operation.action], { name, title: `${webhook.undo?.name ?? ""}${target}` }), canUndo: webhook.operation.action !== "run_now" };
  }
  const skill = card.skillRequest;
  if (skill) {
    return {
      line: t(SKILL_APPLIED_LINE[skill.action], { name, title: skill.name }),
      canUndo: skill.action === "create" || Boolean(skill.previous),
    };
  }
  const profile = card.profileRequest;
  if (profile) {
    const title = PROFILE_REQUEST_FIELDS.filter((field) => profile.changes[field] !== undefined)
      .map((field) => t(PROFILE_FIELD_LABEL[field])).join(", ");
    const line = profile.targetBotId === profile.botId
      ? t("approval.applied.profileOwn", { name, title })
      : t("approval.applied.profileOther", { name, target: `@${profile.targetName}`, title });
    return { line, canUndo: Boolean(profile.undo) };
  }
  const model = card.modelRequest;
  if (model) {
    const title = model.selection.model;
    const line = model.targetBotId === model.botId
      ? t("approval.applied.modelOwn", { name, title })
      : t("approval.applied.modelOther", { name, target: `@${model.targetName}`, title });
    return { line, canUndo: true };
  }
  const setup = card.teamSetupRequest;
  if (setup?.deletion) return { line: t("approval.applied.botDeleted", { name, target: `@${setup.deletion.name}` }), canUndo: false };
  if (setup?.result) {
    const names = (action: "created" | "updated") => setup.result!.bots.filter((bot) => bot.action === action).map((bot) => `@${bot.name}`).join(", ");
    const title = [names("created") && t("approval.applied.teamAdded", { names: names("created") }),
      names("updated") && t("approval.applied.teamUpdated", { names: names("updated") })].filter(Boolean).join("; ");
    return { line: t("approval.applied.teamSetup", { name, title }), canUndo: Boolean(setup.undo) };
  }
  if (card.teamMemoryRequest) {
    return { line: t("approval.applied.teamMemory", { name, title: card.subtitle.split(" — ")[0] ?? "" }), canUndo: Boolean(card.teamMemoryRequest.revision) };
  }
  return undefined;
}

function AppliedChangeLine({
  card,
  name,
  threadId,
  summary,
}: {
  card: OptionCardData;
  name: string;
  threadId?: string;
  summary: { line: string; canUndo: boolean; cancels?: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const [sharing, setSharing] = useState(false);
  // Kept until the card's own patch arrives, so the Share button cannot come back in between.
  const [sharedNow, setSharedNow] = useState<{ requestId: string; shared: SkillShareRecord }>();
  const config = useContext(StoreContext)?.state.config ?? null;
  const reviewsTeamMemory = useOwnerOrAdmin() !== false;
  const canUndo = summary.canUndo && (!card.teamMemoryRequest || reviewsTeamMemory);
  const undone = card.undone === true;
  const cancels = summary.cancels === true;
  const skill = card.skillRequest;
  const shared = skill?.shared ?? (sharedNow && sharedNow.requestId === card.requestId ? sharedNow.shared : undefined);
  const canShare = Boolean(skill && !shared && !undone && threadId && card.requestId)
    && shareLearnedSkillsMode(config) === "ask";
  const share = () => {
    const requestId = card.requestId;
    if (!threadId || !requestId || sharing) return;
    setSharing(true);
    setError(undefined);
    api<{ shared: SkillShareRecord }>(`/api/threads/${threadId}/share-skill`, { method: "POST", body: JSON.stringify({ requestId }) })
      .then((response) => setSharedNow({ requestId, shared: response.shared }))
      .catch((failure: unknown) => {
        setError(t("approval.applied.shareFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      })
      .finally(() => setSharing(false));
  };
  const sharedNames = shared?.assigned.filter((bot) => bot.botId !== skill?.botId).map((bot) => bot.name) ?? [];
  const skippedNames = shared?.skipped.map((bot) => bot.name) ?? [];
  const undo = () => {
    if (!threadId || !card.requestId || undoing) return;
    setUndoing(true);
    setError(undefined);
    api(`/api/threads/${threadId}/undo`, { method: "POST", body: JSON.stringify({ requestId: card.requestId }) })
      .catch((failure: unknown) => {
        // A wait that had already ended answers 409, and its card then says how it ended.
        if (cancels && failure instanceof ApiError && failure.status === 409) return;
        setError(failure instanceof ApiError && failure.body?.code === "changed-since"
          ? t("approval.applied.changedSince")
          : cancels ? t("approval.applied.cancelFailed", { name })
            : t("approval.applied.undoFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      })
      .finally(() => setUndoing(false));
  };
  return (
    <div className="w-full max-w-[840px] text-[13px] text-ink-tertiary" data-applied-change={name}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-5">
        {undone ? <Undo2 size={13} className="shrink-0 self-center" /> : <Check size={13} className="shrink-0 self-center text-success/80" />}
        <span className="min-w-0 break-words">
          {summary.line}
          {shared && !undone && (
            <span> · {sharedNames.length ? t("approval.applied.sharedSkill", { names: sharedNames.join(", ") }) : t("approval.applied.sharedSkillNobody")}</span>
          )}
          {undone && !cancels && <span> · {t("approval.applied.undone")}</span>}
        </span>
        {!undone && canUndo && threadId && (
          <button
            type="button"
            onClick={undo}
            disabled={undoing}
            className={cn(TEXT_ACTION, "text-accent disabled:opacity-60")}
          >
            {cancels ? t(undoing ? "approval.applied.cancelling" : "common.cancel") : t(undoing ? "approval.applied.undoing" : "approval.applied.undo")}
          </button>
        )}
        {canShare && (
          <button
            type="button"
            onClick={share}
            disabled={sharing}
            className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-inset disabled:opacity-60"
          >
            {sharing ? t("approval.applied.sharingSkill") : t("approval.applied.shareSkill")}
          </button>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(TEXT_ACTION, "text-ink-tertiary hover:text-ink-secondary")}
        >
          {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
        </button>
      </div>
      {shared && !undone && skippedNames.length > 0 && (
        <div className="mt-1 text-[13px] text-ink-tertiary">{t("approval.applied.shareSkipped", { names: skippedNames.join(", ") })}</div>
      )}
      {!error && !shared && !undone && skill?.shareError && (
        <div className="mt-1 text-[13px] text-warning">{t("approval.applied.shareFailed", { error: skill.shareError })}</div>
      )}
      {error && <div role="alert" className="mt-1 text-[13px] text-warning">{error}</div>}
      {open && (
        <pre
          tabIndex={0}
          aria-label={t("approval.aria.appliedDetails")}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-inset px-4 py-3 font-mono text-[13px] leading-relaxed text-ink"
        >
          {card.subtitle}
        </pre>
      )}
    </div>
  );
}

export const APPROVAL_CODE_CHIP =
  "inline-flex min-w-0 max-w-full items-baseline rounded-full bg-inset px-2 pb-px pt-[3px] font-mono text-[13px] leading-5 text-ink";

const TEXT_ACTION =
  "inline-flex h-6 items-center rounded-full px-2 hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function firstLineOf(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function CompactApprovalRow({
  header,
  summary,
  detail,
  showDetailInline,
  outcome,
  allowed,
  expired = false,
  byVoice,
  waiting,
  answeredBelow,
}: {
  header: string;
  summary?: string;
  detail: string;
  showDetailInline: boolean;
  outcome?: string;
  allowed: boolean;
  expired?: boolean;
  byVoice: ReactNode;
  waiting: boolean;
  answeredBelow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((value) => !value);
  if (waiting && answeredBelow) {
    return (
      <div data-approval-row="pending" className="sr-only">
        {header}{summary ? ` ${summary}` : ""}{detail && showDetailInline ? ` ${firstLineOf(detail)}` : ""}. {t("approval.status.waitingAnswer")}
      </div>
    );
  }
  return (
    <div
      data-tour={waiting ? "approval" : undefined}
      data-approval-row={waiting ? "pending" : "settled"}
      className={cn("w-full max-w-[840px] text-[13px]", waiting ? "text-ink-secondary" : "text-ink-tertiary")}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 leading-5">
        {waiting
          ? <ShieldCheck size={14} className="shrink-0 self-center text-accent" aria-hidden="true" />
          : allowed
            ? <Check size={14} className="shrink-0 self-center text-success" aria-hidden="true" />
            : expired
              ? <Clock3 size={14} className="shrink-0 self-center" aria-hidden="true" />
              : <X size={14} className="shrink-0 self-center" aria-hidden="true" />}
        <span className={cn("min-w-0 break-words", waiting && "text-ink")}>{header}</span>
        {summary && <span className="min-w-0 break-words">{waiting ? summary : `· ${summary}`}</span>}
        {detail && showDetailInline && (
          <span role="group" aria-label={t("approval.aria.details")} className="min-w-0 max-w-full">
            <button
              type="button"
              aria-expanded={open}
              title={detail}
              onClick={toggle}
              className={cn(APPROVAL_CODE_CHIP, "text-left hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}
            >
              <span className="truncate">{detail}</span>
            </button>
          </span>
        )}
        <span className="shrink-0" aria-live="polite">· {outcome ?? t("approval.status.waitingAnswer")}</span>
        {byVoice}
        {detail && !showDetailInline && (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className={cn(TEXT_ACTION, "text-ink-tertiary hover:text-ink-secondary")}
          >
            {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
          </button>
        )}
      </div>
      {open && (
        <pre
          tabIndex={0}
          aria-label={t("approval.aria.details")}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-inset px-4 py-3 font-mono text-[12px] leading-relaxed text-ink"
        >
          {detail}
        </pre>
      )}
    </div>
  );
}

export function ApprovalCard({
  bot,
  message,
  threadId,
}: {
  bot?: Pick<Bot, "name">;
  message: Message;
  threadId?: string;
}) {
  const card = message.card;
  if (!card) return null;
  if (cardAutomation(card)) return <TriggerCard card={card} threadId={threadId} />;
  const applied = card.autoApplied === true && card.answered === "allow" && !card.held
    ? appliedChange(card, bot?.name ?? t("approval.someone"))
    : undefined;
  if (applied) return <AppliedChangeLine card={card} name={bot?.name ?? t("approval.someone")} threadId={threadId} summary={applied} />;
  const settled = card.answered;
  const expired = card.expired === true || staleRoutineCard(card);
  const via = card.answeredBy?.via;
  const byVoice = via ? <span className="text-ink-tertiary">· {t(via === "call" ? "approval.status.byVoice" : "approval.status.byReaction")}</span> : null;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const isProfileRequest = Boolean(card.profileRequest);
  const isTeamSetup = Boolean(card.teamSetupRequest);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const heldNote = tFromServer(card.heldCode, card.held);
  const outcome = approvalCardOutcome(card);
  const outbound = outboundSummary(card);
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : isProfileRequest
      ? "update_profile"
    : card.tool;
  const profileHeader = isProfileRequest && card.profileRequest
    ? card.profileRequest.targetBotId === card.profileRequest.botId
      ? t("approval.card.profileWantsToOwn", { name: bot?.name ?? t("approval.someone") })
      : t("approval.card.profileWantsToOther", {
          name: bot?.name ?? t("approval.someone"),
          target: card.profileRequest.targetName,
        })
    : undefined;

  const turnOn = computerAskWords(card, bot?.name ?? t("approval.someone"));
  if (turnOn) {
    const state = card.computerAsk?.state;
    const waiting = state === "asking" || state === "failed";
    return (
      <div data-computer-ask={state} className="w-full">
        <CompactApprovalRow header={turnOn.line} summary={waiting ? turnOn.reason : undefined} detail="" showDetailInline={false} outcome={turnOn.outcome}
          allowed={state === "on" || state === "turning-on"} byVoice={byVoice} waiting={waiting} answeredBelow={waiting && !card.dismissed} />
      </div>
    );
  }
  if (!isRoutineRequest && !isSkillRequest && !isProfileRequest && !isTeamSetup && !card.modelRequest) {
    const waiting = !settled && !expired;
    const ask = yourComputerAsk(card, bot?.name ?? t("approval.someone"));
    const header = ask ? ask.line : outbound
      ? waiting ? outbound.headline : outbound.headline.replace(/\s*[?？]$/, "")
      : bot
        ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(displayTool) })
        : t("approval.card.wantsTo", { action: toolLabel(displayTool) });
    const row = (
      <CompactApprovalRow
        header={header}
        summary={outbound?.summary || undefined}
        detail={ask?.detail ?? card.subtitle}
        showDetailInline={!outbound}
        outcome={outcome}
        allowed={settled === "allow" && !expired}
        expired={expired}
        byVoice={byVoice}
        waiting={waiting}
        answeredBelow={Boolean(card.requestId && card.tool && !card.dismissed)}
      />
    );
    return waiting && card.requestId && card.tool ? <div className="flex w-full flex-col gap-1">{row}<CardHint id="spot.approval" /></div> : row;
  }

  return (
    <div
      data-tour={settled || expired ? undefined : "approval"}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled || expired ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {isTeamSetup ? card.title : outbound ? outbound.headline : profileHeader ?? (
            <>
              {bot
                ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(displayTool) })
                : t("approval.card.wantsTo", { action: toolLabel(displayTool) })}
            </>
          )}
        </div>
        {displayTool && !isTeamSetup && !outbound && <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{displayTool}</span>}
      </div>
      {outbound?.summary && <div className="mt-0.5 text-[13px] text-ink-secondary">{outbound.summary}</div>}

      <pre
        tabIndex={0}
        aria-label={
          isRoutineRequest
            ? t("approval.aria.routineDetails")
            : isSkillRequest
              ? t("approval.aria.skillDetails")
              : isProfileRequest
                ? t("approval.aria.profileChange")
                : t("approval.aria.details")
        }
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[13px] leading-relaxed text-ink"
      >
        {card.subtitle}
      </pre>

      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

      {heldNote && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
          {heldNote}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {outcome ? (
          <>
            {settled === "allow" && !expired ? <Check size={14} className="text-success" /> : <X size={14} />} {outcome}
            {byVoice}
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" />
            {isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup
              ? t("approval.status.waitingConfirmation")
              : t("approval.status.waitingAnswer")}
          </>
        )}
      </div>
    </div>
  );
}
