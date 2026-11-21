// A hand-off's status as one small chip: on its "Sent to" row and on the conversation that does the work. Display only.
import type { HandoffStatusLine } from "../../shared/handoff-status";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function handoffStateText(line: HandoffStatusLine): string {
  switch (line.state) {
    case "claimed": return t("chat.handoff.claimed");
    case "working": return t("chat.handoff.working");
    case "waiting": {
      const on = line.waitingOn;
      if (on?.name) return t("chat.handoff.waitingOn", { name: on.name });
      return on?.kind === "bot" ? t("chat.handoff.waitingOnTeammate") : t("chat.handoff.waitingOnYou");
    }
    case "done": return t("chat.handoff.done");
    case "failed": return line.why ? t("chat.handoff.failedWhy", { why: line.why }) : t("chat.handoff.failed");
  }
}

/** The chip's whole text: the state, and on a Team Cloud whose request it is. */
export function handoffStatusText(line: HandoffStatusLine): string {
  const state = handoffStateText(line);
  const person = line.forPerson;
  if (!person) return state;
  return t(person.private ? "chat.handoff.forPrivate" : "chat.handoff.for", { status: state, name: person.name });
}

const TONE: Record<HandoffStatusLine["state"], string> = {
  claimed: "bg-ink-tertiary",
  working: "bg-accent",
  waiting: "bg-warning",
  done: "bg-success",
  failed: "bg-danger",
};

export function HandoffStatusChip({ line, className }: { line: HandoffStatusLine; className?: string }) {
  const text = handoffStatusText(line);
  return (
    <span data-handoff-status={line.state} title={text} role="status"
      className={cn("inline-flex min-w-0 max-w-[320px] items-center gap-1.5 text-[12px] text-ink-secondary", line.state === "failed" && "text-danger", className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE[line.state], line.state === "working" && "animate-pulse")} />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
