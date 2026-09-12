/**
 * Structured questions raised by a provider's own "ask the human" tool —
 * Claude Code's built-in `AskUserQuestion`.
 *
 * That tool reaches us as a PERMISSION ask (the CLI routes it through
 * --permission-prompt-tool like any other tool use), which is exactly the
 * wrong shape: a person cannot answer "which model should this bot use?"
 * with Deny / Always allow / Allow once. So the ask is re-read here into the
 * questions the model actually posed, the card renders them as choices, and
 * the answer goes back as text.
 *
 * The payload is bot-authored, so every field is treated as untrusted: the
 * shape is validated rather than cast, and the counts and lengths are capped
 * so a runaway (or hostile) tool call cannot produce an unreadable card.
 */

/** The provider tool whose input this module understands. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** Caps. Claude Code's own limits are smaller (1-4 questions, 2-4 options);
 * these leave room for a provider that widens them without letting a card
 * grow without bound. */
export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 12;
const MAX_QUESTION_TEXT = 400;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 400;
/** One free-text answer. Long enough for a sentence or two of context. */
export const MAX_CUSTOM_ANSWER = 2000;

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** Short tab label the model gives each question ("Schedule", "Model"). */
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

/** Durable payload on a question card. Versioned like the other card
 * payloads so a later shape change can be told apart from this one. */
export interface QuestionRequestCardData {
  version: 1;
  questions: AskQuestion[];
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): AskQuestionOption | null {
  // A bare string is not the documented shape, but it is the obvious
  // degradation and costs one line to accept.
  if (typeof value === "string") {
    const label = text(value, MAX_LABEL);
    return label ? { label } : null;
  }
  if (!isRecord(value)) return null;
  const label = text(value.label, MAX_LABEL);
  if (!label) return null;
  const description = text(value.description, MAX_DESCRIPTION);
  return description ? { label, description } : { label };
}

function parseQuestion(value: unknown): AskQuestion | null {
  if (!isRecord(value)) return null;
  const question = text(value.question, MAX_QUESTION_TEXT);
  if (!question) return null;
  const options: AskQuestionOption[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.options) ? value.options : []) {
    const option = parseOption(raw);
    // Duplicate labels are the one thing a radio group cannot survive: the
    // answer text could no longer say which row was picked.
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  // A question with nothing to choose from is still answerable — the card
  // always offers free text — so an empty option list is kept, not dropped.
  const header = text(value.header, MAX_LABEL);
  return {
    question,
    ...(header ? { header } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    options,
  };
}

/** The questions inside an AskUserQuestion tool input, or null when the
 * payload is not one (a malformed call falls back to the ordinary card). */
export function parseAskQuestions(input: unknown): AskQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions: AskQuestion[] = [];
  for (const raw of input.questions) {
    const question = parseQuestion(raw);
    if (!question) continue;
    questions.push(question);
    if (questions.length === MAX_QUESTIONS) break;
  }
  return questions.length ? questions : null;
}

/** The one line the card subtitle and a spoken prompt show. */
export function askQuestionSummary(questions: readonly AskQuestion[]): string {
  const first = questions[0]?.question ?? "";
  const rest = questions.length - 1;
  return rest > 0 ? `${first} (+${rest} more question${rest > 1 ? "s" : ""})` : first;
}

/** Flat labels for clients that only know how to render a list of choices
 * (the phone companions, and any older desktop build). Only a single
 * question can be answered that way without losing which one was answered. */
export function questionChoices(questions: readonly AskQuestion[]): string[] | undefined {
  if (questions.length !== 1) return undefined;
  const only = questions[0]!;
  if (only.multiSelect || only.options.length < 2) return undefined;
  return only.options.map((option) => option.label);
}

/** The lead-in on a formatted answer. It exists for the model — the answer
 * is delivered on the deny channel, so it has to say what it is — and the
 * card strips it back off when it shows the person what they sent. */
export const ANSWER_PREAMBLE = "The user answered your questions.";

/**
 * What the model is told. It arrives as the tool's result, so it has to
 * stand on its own: name each question, then what was picked for it.
 */
export function formatQuestionAnswers(
  questions: readonly AskQuestion[],
  answers: readonly (readonly string[])[],
): string {
  const blocks: string[] = [];
  questions.forEach((question, index) => {
    const picked = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean);
    if (!picked.length) return;
    blocks.push(`Q: ${question.question}\nA: ${picked.join(", ")}`);
  });
  if (!blocks.length) return "";
  return `${ANSWER_PREAMBLE}\n\n${blocks.join("\n\n")}`;
}

/** The same answer with the model-facing lead-in removed, for the settled
 * card. Anything that does not carry the lead-in is shown as it is. */
export function answerWithoutPreamble(answer: string): string {
  return answer.startsWith(`${ANSWER_PREAMBLE}\n\n`) ? answer.slice(ANSWER_PREAMBLE.length + 2) : answer;
}

/**
 * The answer text, read back as one value per question.
 *
 * `AskUserQuestion` is answered through its own `answers` field, keyed by the
 * question's text — but the card sends ONE answer for the whole set, because
 * a person answers the whole card at once. `formatQuestionAnswers` writes
 * each question's text beside its answer for exactly this reason, so the map
 * is recovered rather than guessed.
 *
 * A message that carries no blocks at all is the flat path: an older client,
 * or a phone answering a single-question card with one of the option labels
 * the harness also sends. With exactly one question there is no ambiguity
 * about what it answers, so the whole message is that question's answer.
 * With more than one there is, and nothing is filed.
 */
export function questionAnswersByQuestion(
  message: string,
  questions: readonly AskQuestion[],
): Record<string, string> {
  const answers: Record<string, string> = {};
  const known = new Map(questions.map((entry) => [entry.question, entry.question]));
  for (const block of message.split("\n\n")) {
    const match = /^Q: ([\s\S]+?)\nA: ([\s\S]+)$/.exec(block.trim());
    if (!match) continue;
    // Only a question this ask actually posed. An unrecognized block is
    // dropped rather than filed under a key the tool never asked about.
    const question = known.get(match[1]!.trim());
    if (question) answers[question] = match[2]!.trim();
  }
  if (Object.keys(answers).length) return answers;
  const only = questions.length === 1 ? questions[0] : undefined;
  const flat = message.trim();
  return only && flat ? { [only.question]: flat } : {};
}
