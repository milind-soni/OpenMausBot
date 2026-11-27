import type { RequestOutcome, RuntimeEvent } from "../../contracts.ts";
import { newId } from "../../contracts.ts";
import { askQuestionSummary, MAX_QUESTIONS, questionChoices, type AskQuestion } from "../../../shared/ask-question.ts";

/** A vendor request that blocks the agent until a person answers structured questions. No approval level answers it. */
export interface AcpQuestionRequest {
  /** null when the params carry no answerable question; `answered` returns null when the reply maps to no answer. */
  parse(params: unknown): { questions: AskQuestion[]; answered(message: string): unknown } | null;
  /** The reply when nobody answered: the turn ended or it arrived between turns. */
  cancelled: unknown;
}

type QuestionFinish = (behavior: string, source?: "user" | "timeout" | "system", message?: string) => RequestOutcome;

/** Own keys only: a method named like an Object.prototype member is not one. */
export function questionRequestFor(
  requests: Readonly<Record<string, AcpQuestionRequest>> | undefined,
  method: unknown,
): AcpQuestionRequest | undefined {
  return typeof method === "string" && requests && Object.hasOwn(requests, method) ? requests[method] : undefined;
}

/** One question card for the whole set, open until the person answers or the turn ends. Only the person's own reply answers it; anything else sends the vendor's
 * cancelled reply, so the agent is never left blocked and no system note reads as an answer. */
export function openQuestionRequest(
  msg: { id?: unknown; params?: unknown },
  request: AcpQuestionRequest,
  turn: { asks: Map<string, QuestionFinish>; controlsHost: boolean; flushAssistantText: () => void },
  send: (message: unknown) => void,
  emit: (event: RuntimeEvent) => void,
  base: () => Pick<RuntimeEvent, "eventId" | "provider" | "threadId" | "turnId" | "createdAt">,
): void {
  const parsed = request.parse(msg.params);
  if (!parsed) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `ask needs 1 to ${MAX_QUESTIONS} distinct questions with question text` } });
    return;
  }
  turn.flushAssistantText();
  const requestId = newId();
  const finish: QuestionFinish = (behavior, source = "user", message) => {
    if (!turn.asks.delete(requestId)) return "unavailable";
    const reply = behavior === "answer" && source === "user" && typeof message === "string" && message.trim()
      ? parsed.answered(message)
      : null;
    const answered = reply !== null && reply !== undefined;
    send({ jsonrpc: "2.0", id: msg.id, result: answered ? reply : request.cancelled });
    emit({ ...base(), type: "request.resolved", requestId, behavior: answered ? "answer" : "deny", source });
    return answered ? "answered" : "rejected";
  };
  turn.asks.set(requestId, finish);
  const choices = questionChoices(parsed.questions);
  emit({
    ...base(),
    type: "request.opened",
    requestId,
    requestType: "question",
    // the name the ASKS_A_PERSON backstop knows
    tool: "ask_user",
    summary: askQuestionSummary(parsed.questions),
    questions: parsed.questions,
    ...(choices ? { choices } : {}),
    approvalScope: turn.controlsHost ? "local-computer" : undefined,
  });
}
