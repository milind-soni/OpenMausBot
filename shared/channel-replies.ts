import { MAX_CUSTOM_ANSWER, parseAskQuestions, type AskQuestion } from "./ask-question.ts";
import { formatChannelText } from "./channel-text.ts";
import type { OptionCardData } from "./wire.ts";

/** These cards need the app's dedicated review UI and submission path. */
export function isChannelReviewCard(card: OptionCardData): boolean {
  return Boolean(card.profileRequest || card.modelRequest || card.routineRequest || card.skillRequest ||
    card.teamSetupRequest || card.teamMemoryRequest);
}

/** Read the same questions the app displays; permission button labels are
 * never suggested answers to a question. A malformed structured payload
 * must not silently degrade into the summary of a different question set. */
export function channelQuestions(card: OptionCardData): AskQuestion[] | null {
  if (isChannelReviewCard(card)) return null;
  if (card.questionRequest) return parseAskQuestions(card.questionRequest);
  if (card.requestType !== "question" && (card.requestType === "permission" || card.tool)) return null;
  return parseAskQuestions({ questions: [{ question: card.subtitle?.trim() || card.title, options: card.options }] });
}

/** index is zero-based, matching the stored question array. */
export function formatChannelQuestion(question: AskQuestion, _code: string, index: number, total: number): string {
  const lines = [`Question ${index + 1} of ${total}`, formatChannelText(question.question)];
  if (question.options.length) {
    lines.push(question.options.map((option, optionIndex) =>
      `${optionIndex + 1}. ${formatChannelText(option.label)}${option.description ? ` — ${formatChannelText(option.description)}` : ""}`).join("\n"));
    lines.push(question.multiSelect
      ? "Reply with one or more numbers separated by commas (for example, 1,2), or answer in your own words."
      : "Reply with a number or answer in your own words.");
  } else {
    lines.push("Reply in your own words.");
  }
  return lines.join("\n\n");
}

export function parseChannelQuestionReply(question: AskQuestion, text: string, code: string): { answers: string[] } | { error: string } {
  let answer = text.trim();
  if (/^ANSWER(?:\s|$)/i.test(answer)) {
    const explicit = /^ANSWER\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(answer);
    if (!explicit || explicit[1]!.toUpperCase() !== code.toUpperCase()) {
      return { error: "That answer code does not match this question." };
    }
    answer = (explicit[2] ?? "").trim();
  }
  if (!answer) return { error: "Reply with an answer to this question." };
  if (answer.length > MAX_CUSTOM_ANSWER) return { error: `Keep your answer within ${MAX_CUSTOM_ANSWER} characters.` };
  if (question.options.some(option => option.label === answer)) return { answers: [answer] };
  if (question.options.length && /^[+-]?\d+(?:\s*,\s*[+-]?\d+)*$/.test(answer)) {
    const selected = answer.split(",").map(value => Number(value.trim()));
    if (selected.some(value => !Number.isSafeInteger(value) || value < 1 || value > question.options.length)) {
      return { error: `Choose a number from 1 to ${question.options.length}, or answer in your own words.` };
    }
    if (!question.multiSelect && selected.length > 1) return { error: "Choose just one option, or answer in your own words." };
    return { answers: [...new Set(selected.map(value => question.options[value - 1]!.label))] };
  }
  return { answers: [answer] };
}

/** Never truncate an approval: a person must see every available request
 * detail before their exact, one-time verdict can be used. */
export function formatChannelApproval(card: OptionCardData, _code: string): string | null {
  if (isChannelReviewCard(card) || card.questionRequest || card.requestType === "question" ||
    (card.requestType !== "permission" && !card.tool)) return null;
  const lines = [card.title];
  if (card.tool) lines.push(`Tool: ${card.tool}`);
  if (card.subtitle) lines.push(card.subtitle);
  if (card.outboundRequest) {
    const outbound = card.outboundRequest;
    lines.push(`Outbound tool: ${outbound.tool}${outbound.app ? `\nApp: ${outbound.app}` : ""}`);
    if (outbound.calls?.length) lines.push(outbound.calls.map((call, index) =>
      `${index + 1}. ${call.app ? `${call.app}: ` : ""}${call.label}`).join("\n"));
  }
  if (card.commandAllowlist) {
    lines.push(`Command:\n${card.commandAllowlist.command}`, `Working directory: ${card.commandAllowlist.cwd}`);
  }
  if (card.held) lines.push(card.held);
  lines.push('Reply "yes" or "approve" to allow this request once, or "no" or "deny" to reject it.\n\nFor automatic approvals in this messaging conversation, reply "approve for me". Reply "ask me first" to switch back. NEW starts a separate task with Ask first.');
  const result = lines.join("\n\n");
  return result.length <= 16_000 ? result : null;
}
