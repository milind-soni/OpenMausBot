// A finished Live call's record in its chat: what the call was (its title,
// or "Call with <bot>"), how long it lasted, and one line per thing the bot
// did on it: its steps by name (never their arguments) and its approvals
// with their outcomes. The call's spoken requests and the bot's answers stay
// inline where they were; this row only sums the call up.
import { useMemo } from "react";
import { AudioLines, Check, X } from "lucide-react";

import { formatCallDuration } from "../../shared/live-call";
import { callRecordLines, type CallRecordLine } from "@/lib/call-record";
import { t } from "@/lib/i18n";
import { activityStepLabel } from "@/lib/live-activity";
import type { Message } from "@/state/store";
import { approvalCardOutcome, toolLabel } from "./ApprovalCard";
import { WorkingDots } from "./WorkingIndicator";

/** Done, refused or failed, or still waiting: the glyph before a line. */
function lineState(line: CallRecordLine): "done" | "stopped" | "open" {
  if (line.kind === "step") return line.tool.ok === undefined ? "open" : line.tool.ok ? "done" : "stopped";
  if (line.card.expired) return "stopped";
  if (!line.card.answered) return "open";
  return line.card.answered === "allow" ? "done" : "stopped";
}

/** What a step's glyph shows, in words for a reader who cannot see it. An
 * approval says its outcome in its own text ("Allowed: run a command"), so
 * only a step needs this. */
const STEP_STATUS = {
  done: "chat.callRecord.stepDone",
  stopped: "chat.callRecord.stepFailed",
  open: "chat.callRecord.stepRunning",
} as const;

function lineText(line: CallRecordLine): string {
  if (line.kind === "step") return activityStepLabel(line.tool);
  const text = t("chat.callRecord.approval", {
    outcome: approvalCardOutcome(line.card) ?? t("chat.callRecord.waiting"),
    action: toolLabel(line.card.tool),
  });
  return line.card.answeredBy?.via === "call" ? `${text} · ${t("approval.status.byVoice")}` : text;
}

export function CallRecordRow({ message, transcript, botName }: {
  message: Message;
  /** The chat's active branch. The call's lines come from all of it, also
   * from steps that landed after this row (a turn still running at hang-up). */
  transcript: readonly Message[];
  botName: string;
}) {
  const call = message.call;
  const callId = call?.callId;
  // Each call's lines are worked out again only when the transcript changes
  // (a message or a patch, not a streamed delta), not on every render: the
  // chat holds a row per call, and each walks the whole transcript.
  const lines = useMemo(() => (callId === undefined ? [] : callRecordLines(transcript, callId)), [transcript, callId]);
  if (!call) return null;
  const title = call.title?.trim() || t("chat.callRecord.title", { name: botName });
  const duration = formatCallDuration(call.seconds);
  return (
    <section
      data-testid="call-record"
      aria-label={t("chat.callRecord.label", { title, duration })}
      title={new Date(call.endedAt).toLocaleString()}
      className="mx-auto flex w-fit max-w-[min(32rem,90%)] flex-col items-center gap-1 rounded-2xl border border-hairline/40 bg-panel px-4 py-2 text-[13px] text-ink-secondary"
    >
      <div className="flex max-w-full items-center gap-2">
        <AudioLines size={14} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0 truncate font-medium text-ink">{title}</span>
        <span className="shrink-0 tabular-nums">{`· ${duration}`}</span>
      </div>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[12.5px]">
          {lines.map((line) => {
            const state = lineState(line);
            return (
              <li key={line.id} className="flex items-center gap-1.5">
                <span className="shrink-0" aria-hidden="true">
                  {state === "open" ? <WorkingDots size={3} /> : state === "done" ? <Check size={12} className="text-success" /> : <X size={12} className="text-danger" />}
                </span>
                <span className="min-w-0 truncate">
                  {lineText(line)}
                  {line.kind === "step" && <span className="sr-only">{` (${t(STEP_STATUS[state])})`}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
