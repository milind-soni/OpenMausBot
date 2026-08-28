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

interface ApprovalLabels {
  [tool: string]: string;
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
  if (!isRoutineRequest) {
    return `${requester} wants to ${pending.tool}. ${pending.detail}. Should I allow it?`;
  }
  const title = pending.message.card?.title.trim() || "Confirm this routine?";
  return `${requester} asks: ${title}${/[.!?]$/.test(title) ? "" : "."} Review the schedule and instructions on screen. Should I confirm it?`;
}

function label(pending: Pending): string {
  if (isRoutineApproval(pending)) {
    return pending.message.card?.routineRequest?.operation.action === "create"
      ? "Confirm this routine"
      : "Confirm this routine change";
  }
  const nice: ApprovalLabels = {
    Bash: "Command approval requested",
    shell: "Command approval requested",
    Read: "File-read approval requested",
    Write: "File-change approval requested",
    Edit: "File-change approval requested",
    edit: "File-change approval requested",
  };
  return nice[pending.tool] ?? "Approval requested";
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
      aria-label={isRoutineApproval(pending) ? "Pending routine confirmation" : "Pending approval"}
      className="rounded-t-2xl border-b border-hairline/50 bg-control/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
        <span className="text-[13px] text-ink">{label(pending)}</span>
        <span className="font-mono text-[11px] text-ink-secondary">
          {isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.operation.action === "create"
              ? "schedule_routine"
              : "manage_routine"
            : pending.tool}
        </span>
      </div>
      {/* never truncated — long commands wrap and scroll */}
      <pre
        tabIndex={0}
        aria-label={isRoutineApproval(pending) ? "Routine details to review" : "Approval details to review"}
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {pending.detail}
      </pre>
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
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-2 py-2">
      {!isRoutineRequest && (
        <button onClick={onCancelTurn} className={cn(base, "text-ink-secondary hover:bg-control hover:text-ink")}>
          Cancel turn
        </button>
      )}
      <button
        onClick={() => decide("deny")}
        className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
      >
        {isRoutineRequest ? "Cancel" : "Deny"}
      </button>
      {!isRoutineRequest && bot && pending.allowKey && (
        <button
          onClick={() => decide("allow", true)}
          title={`Stop asking ${bot.name} about ${pending.allowKey}`}
          className={cn(base, "border border-hairline/50 text-ink hover:bg-control")}
        >
          Always allow
        </button>
      )}
      <button
        onClick={() => decide("allow")}
        className={cn(base, "bg-accent font-medium text-white hover:brightness-110")}
      >
        {isRoutineRequest ? "Confirm" : "Allow once"}
      </button>
    </div>
  );
}
