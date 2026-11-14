// A routine run as its source conversation shows it: the card, and the plain text clients without cards read.
import type { Message } from "./store.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoutineRun } from "./routines.ts";
import { serverLine, type ServerLineKey } from "./server-lines.ts";

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

/** The words for where the run stands; null for a status with none. */
function stateKey(card: NonNullable<Message["routineRun"]>): ServerLineKey | null {
  switch (card.goalStatus) {
    case "needs-input": return "server.runs.state.needsInput";
    case "blocked": return "server.runs.state.blocked";
    case "limit-reached": return "server.runs.state.limitReached";
    case "stopped": return "server.runs.state.stopped";
    case "failed": return "server.runs.state.failed";
  }
  switch (card.status) {
    case "waiting": return "server.runs.state.waiting";
    case "completed": return "server.runs.state.completed";
    case "failed": return "server.runs.state.failed";
    case "cancelled": return "server.runs.state.cancelled";
    case "missed": return "server.runs.state.missed";
    case "queued": return card.deferredAt != null ? "server.runs.state.deferred" : "server.runs.state.queued";
    case "running": return "server.runs.state.running";
  }
  return null;
}

/** In the language of the conversation's person (server/server-lines.ts). */
export function routineRunFallbackText(card: NonNullable<Message["routineRun"]>, language?: string): string {
  const key = stateKey(card);
  const state = key ? serverLine(language, key) : card.status;
  const detail = card.summary ?? card.error;
  return `${serverLine(language, "server.runs.card.line", { name: card.routineName, state })}${detail ? `\n\n${detail}` : ""}`;
}
