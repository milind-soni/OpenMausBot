import {
  askQuestionSummary, parseAsyncQuestions, questionAnswersById, questionChoices, type AskQuestion, type ProtocolAskQuestion,
} from "../../shared/ask-question.ts";
import { newId, type RequestOutcome, type SteerOutcome } from "../contracts.ts";

/** A pending ask on a Codex turn; an async question's answer settles only once the steer does. */
export type CodexAsk = (
  behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system",
) => void | Promise<RequestOutcome>;

type AsyncQuestionEvent =
  | { type: "request.opened"; requestId: string; requestType: "question"; tool: string; summary: string; questions: AskQuestion[]; choices?: string[] }
  | { type: "request.resolved"; requestId: string; behavior: "answer" | "deny"; source: "user" | "timeout" | "system" };

/**
 * Codex's request_user_input_async posts its questions on an agent message (`delivery: "async"`) and keeps working;
 * no server request follows. They open the ordinary question card. An answer is steered into the running turn; once
 * that turn is gone the request is unavailable, and the harness sends the answer as the person's reply.
 */
export function openAsyncQuestion(
  item: { delivery?: unknown; questions?: unknown },
  asks: Map<string, CodexAsk>,
  steer: (text: string) => Promise<SteerOutcome>,
  emit: (event: AsyncQuestionEvent) => void,
): void {
  const questions = item.delivery === "async" ? parseAsyncQuestions(item.questions) : null;
  if (!questions) return;
  const requestId = newId();
  asks.set(requestId, async (behavior, message, source = "user") => {
    if (!asks.delete(requestId)) return "unavailable";
    if (behavior !== "answer" || source !== "user" || !message?.trim()) {
      emit({ type: "request.resolved", requestId, behavior: "deny", source });
      return "rejected";
    }
    if (await steer(message) === "refused") {
      emit({ type: "request.resolved", requestId, behavior: "deny", source: "system" });
      return "unavailable";
    }
    emit({ type: "request.resolved", requestId, behavior: "answer", source: "user" });
    return "answered";
  });
  const choices = questionChoices(questions);
  emit({
    type: "request.opened", requestId, requestType: "question", tool: "ask_user", summary: askQuestionSummary(questions), questions,
    ...(choices ? { choices } : {}),
  });
}

/** requestUserInput's reply. Only the person's reply is filed: system notes never occupy the slot the model reads as their words. */
export function codexQuestionReply(
  behavior: "allow" | "deny" | "answer", message: string | undefined, source: "user" | "timeout" | "system", questions: ProtocolAskQuestion[],
): { answers: Record<string, { answers: string[] }> } {
  const mapped = behavior === "answer" && source === "user" && typeof message === "string" ? questionAnswersById(message, questions) : {};
  // Null prototype: an id like __proto__ must not hit the inherited setter.
  const answers: Record<string, { answers: string[] }> = Object.create(null);
  for (const [id, answer] of Object.entries(mapped)) answers[id] = { answers: [answer] };
  return { answers };
}
