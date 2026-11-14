import { isPersistentQuestionCard, QUESTION_DISMISS_MESSAGE } from "../shared/ask-question.ts";
import type { Message, Store } from "./store.ts";

/** Null when the respond does not close a question card. */
export function dismissQuestionCard(
  store: Pick<Store, "patchMessage">,
  threadId: string,
  pending: Message | undefined,
  body: { dismiss?: unknown; message?: unknown },
): { status: number; body: Record<string, unknown> } | null {
  if (!isPersistentQuestionCard(pending?.card) || !(body.dismiss === true || body.message === QUESTION_DISMISS_MESSAGE)) return null;
  if (!pending?.card) return { status: 404, body: { error: "this question is no longer available" } };
  if (pending.card.answered !== "answer" || pending.card.dismissed) {
    return { status: 409, body: { error: "answer this question before dismissing it" } };
  }
  store.patchMessage(threadId, pending.id, { card: { ...pending.card, dismissed: true } });
  return { status: 200, body: { ok: true, dismissed: true } };
}
