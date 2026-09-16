// The pause card (Phase 2, budget defaults): when a board task pauses at
// its money cap, the run's thread gets one card with three one-tap answers
// — allow a fixed step more, finish without a cap, or stop — instead of a
// form asking for a number nobody can guess. Same harness-native shape as
// the quota card (quota-switch.ts): a question-shaped card, fixed options,
// settled through the respond endpoint, at most one pending per task.
import { newId } from "./contracts.ts";
import type { Message, Store } from "./store.ts";
import { BUDGET_PAUSED_REASON, getTask, patchTask, setStatus, type BoardTask } from "./task-board.ts";

export const BUDGET_CARD_STOP = "Stop this task";
export const BUDGET_CARD_NO_CAP = "Finish without a cap";

/** The step a tap allows: the cap itself, never less than a dollar, so one
 * tap on a small task roughly doubles what it may spend. */
export function budgetStepUsd(task: Pick<BoardTask, "budgetUsd">): number {
  return Math.max(1, Math.round((task.budgetUsd ?? 1) * 100) / 100);
}
export const allowMoreLabel = (stepUsd: number) => `Allow $${stepUsd.toFixed(2)} more`;

interface PendingBudgetCard { taskId: string; threadId: string; messageId: string; stepUsd: number }
const pendingByRequest = new Map<string, PendingBudgetCard>();
const pendingByTask = new Map<string, string>();

/** Raise the card in the task's run thread; null when one is already
 * pending for the task or the task has no thread. */
export function raiseBudgetCard(store: Store, task: BoardTask): Message | null {
  if (!task.threadId || pendingByTask.has(task.id)) return null;
  const stepUsd = budgetStepUsd(task);
  const requestId = newId();
  const card = store.appendMessage(task.threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `Paused at $${task.spentUsd.toFixed(2)} — its budget was $${(task.budgetUsd ?? 0).toFixed(2)}`,
      subtitle: `"${task.title}" stopped before spending more. What now?`,
      options: [allowMoreLabel(stepUsd), BUDGET_CARD_NO_CAP, BUDGET_CARD_STOP],
      requestId,
      fixedOptions: true,
    },
  });
  pendingByRequest.set(requestId, { taskId: task.id, threadId: task.threadId, messageId: card.id, stepUsd });
  pendingByTask.set(task.id, requestId);
  return card;
}

function settle(store: Store, pending: PendingBudgetCard, chosenText: string): void {
  const existing = store.messagesFor(pending.threadId).find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  store.patchMessage(pending.threadId, pending.messageId, { card: { ...existing.card, answered: "answer", answeredText: chosenText } });
}

/** Apply the tap. True when the request was a pending budget card. */
export function resolveBudgetCard(store: Store, requestId: string, message: string | undefined): boolean {
  const pending = pendingByRequest.get(requestId);
  if (!pending) return false;
  pendingByRequest.delete(requestId);
  if (pendingByTask.get(pending.taskId) === requestId) pendingByTask.delete(pending.taskId);
  const task = getTask(pending.taskId);
  const chosen = message?.trim() ?? "";
  settle(store, pending, chosen || BUDGET_CARD_STOP);
  if (!task) return true;
  const note = (text: string) => store.appendMessage(pending.threadId, { role: "bot", kind: "activity", tool: { name: text, ok: true } });
  if (chosen === allowMoreLabel(pending.stepUsd)) {
    const raised = patchTask(task.id, { budgetUsd: Math.round((task.spentUsd + pending.stepUsd) * 100) / 100 });
    note(`budget raised to $${raised.budgetUsd!.toFixed(2)} — the task can run again`);
  } else if (chosen === BUDGET_CARD_NO_CAP) {
    patchTask(task.id, { budgetUsd: null });
    note("budget cap removed — the task can run again");
  } else {
    if (task.status === "blocked" && task.blockedReason === BUDGET_PAUSED_REASON) setStatus(task.id, "archived");
    note("task stopped at its budget");
  }
  return true;
}

/** Tests and thread cleanup. */
export function forgetBudgetCards(): void {
  pendingByRequest.clear();
  pendingByTask.clear();
}
