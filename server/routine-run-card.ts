// A routine run as its source conversation shows it: the card, and the plain text clients without cards read.
import type { Message } from "./store.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoutineRun } from "./routines.ts";

export function routineRunCard(run: RoutineRun): NonNullable<Message["routineRun"]> {
  const visibleSummary = run.status === "waiting" ? run.attention : run.output;
  const summary = visibleSummary ? redactSecretsInText(visibleSummary).slice(0, 2_000) : undefined;
  const error = run.error ? redactSecretsInText(run.error).slice(0, 500) : undefined;
  const card: NonNullable<Message["routineRun"]> = {
    runId: run.id,
    routineId: run.routineId,
    routineName: redactSecretsInText(run.routineName),
    scheduledFor: run.scheduledFor,
    status: run.status,
  };
  if (run.goalStatus) card.goalStatus = run.goalStatus;
  if (run.deferredAt != null && run.status === "queued") card.deferredAt = run.deferredAt;
  if (run.threadId) card.executionThreadId = run.threadId;
  if (summary) card.summary = summary;
  if (error) card.error = error;
  return card;
}

export function routineRunFallbackText(card: NonNullable<Message["routineRun"]>): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status === "queued" && card.deferredAt != null
                ? "deferred: target busy"
              : card.status
  );
  const detail = card.summary ?? card.error;
  return `Routine “${card.routineName}” ${state}${detail ? `\n\n${detail}` : ""}`;
}
