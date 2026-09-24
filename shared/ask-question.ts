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
  /** Where the ask came from: a real tool call ("tool", also the meaning
   * of absent on cards saved before this field existed) or a block OMB
   * parsed out of model-authored output ("output" — the BoxAgent
   * transport). Only drives the agent-composed badge; it never changes
   * how a card is answered. */
  origin?: "tool" | "output";
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit).trim() : undefined;
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

/** The fenced block a turn-boundary agent ends its run with when it wants
 * to ask the person something (the BoxAgent transport): the harness cannot
 * pause mid-run, so the questions ride the final output and OMB parses them
 * at settle. The block is model-authored — untrusted input like any tool
 * call — so its body runs through parseAskQuestions and the same caps. */
const OMB_ASK_FENCE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*omb-ask[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]{0,3}\2[ \t]*(?=\r?\n|$)/;
const OMB_ASK_FENCE_GLOBAL = new RegExp(OMB_ASK_FENCE.source, OMB_ASK_FENCE.flags + "g");

/** The questions inside the first fenced omb-ask block in an output, or
 * null when there is nothing worth showing (no fence, invalid JSON, or no
 * entry that parses as a question). The first fence wins: a second block
 * in the same output is ignored, not merged. */
export function parseOmbAskQuestions(output: string): AskQuestion[] | null {
  const match = OMB_ASK_FENCE.exec(output);
  if (!match) return null;
  try {
    return parseAskQuestions(JSON.parse(match[3]!));
  } catch {
    return null;
  }
}

/** The output with its omb-ask block(s) removed, for display: the person
 * reads the prose around the ask, never the raw protocol JSON. Text
 * without a block is returned untouched. */
export function stripOmbAskBlock(output: string): string {
  if (!OMB_ASK_FENCE.test(output)) return output;
  return output.replace(OMB_ASK_FENCE_GLOBAL, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The one line the card subtitle and a spoken prompt show. */
export function askQuestionSummary(questions: readonly AskQuestion[]): string {
  const first = questions[0]?.question ?? "";
  const rest = questions.length - 1;
  return rest > 0 ? `${first} (+${rest} more question${rest > 1 ? "s" : ""})` : first;
}

/** How many one-tap answers an `ask_user` card offers; the tool advertises
 * "2-5 suggested answers". */
export const MAX_CHOICES = 5;

/**
 * Flat labels from a bot-authored `ask_user` `choices` array.
 *
 * The tool schema says strings, but a model that has also seen Claude's
 * AskUserQuestion will hand over `{ label, description }` rows instead
 * (MiniMax M3 does). The label is the choice either way. Anything else is
 * dropped: a non-string choice that reached the card was drawn as a React
 * child, which React refuses, taking the whole chat page down with it.
 */
export function parseChoices(input: unknown, limit = MAX_CHOICES): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const label = typeof raw === "string" ? text(raw, MAX_LABEL) : isRecord(raw) ? text(raw.label, MAX_LABEL) : undefined;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    choices.push(label);
    if (choices.length === limit) break;
  }
  return choices.length ? choices : undefined;
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

/** The chat runtime's own ask tool: the OpenAI-compatible engines'
 * counterpart of ASK_USER_QUESTION. Named ask_user so the ASKS_A_PERSON
 * backstop already covers it — no auto mode may answer a question. */
export const ASK_USER_TOOL = "ask_user";

/** The ask_user definition shared by every chat-runtime engine, shaped for
 * an OpenAI function-calling tool list. The schema states the caps; the
 * parser enforces them again on arrival, because a model-authored argument
 * is a request to follow the schema, not a guarantee that it did. */
export const ASK_USER_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: ASK_USER_TOOL,
    description:
      "Ask the person questions when the decision is theirs. Offer concrete options where they exist; they can always answer in their own words. Ask up to six questions in one call rather than one at a time.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question to show the person." },
              header: { type: "string", description: "A short label for the question's tab." },
              multiSelect: { type: "boolean", description: "Whether several options may be picked." },
              options: {
                type: "array",
                maxItems: MAX_OPTIONS,
                description: "Suggested answers; the person may always write their own.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
} as const;

/** The synthetic tool string for an ask parsed out of model-authored final
 * output (the BoxAgent turn-held transport): there is no tool call to name,
 * but the event and the ASKS_A_PERSON backstop need one string. */
export const OMB_ASK_TOOL = "omb-ask";

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

/** The longest formatted answer OMB will echo back into a follow-up prompt
 * (the BoxAgent continuation). formatQuestionAnswers itself does not
 * truncate — the tool-result channel has no stated limit — but a prompt is
 * not the place to find one: six answers at the custom-answer cap is the
 * most a legitimate reply weighs, so that is the ceiling. */
export const MAX_ANSWER_ECHO = 6 * MAX_CUSTOM_ANSWER;

/** Cap a formatted answer for echoing into a follow-up prompt. An over-cap
 * echo is cut back to the last whole block so no partial answer reads as
 * one, and says it was truncated. */
export function capAnswerEcho(answer: string, limit = MAX_ANSWER_ECHO): string {
  if (answer.length <= limit) return answer;
  const cut = answer.slice(0, limit);
  const boundary = cut.lastIndexOf("\n\nQ: ");
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return kept + "\n\n[answer truncated]";
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
  return questionAnswersById(message, questions.map(question => ({ id: question.question, question })));
}

/** Longest protocol id accepted. Ids are harness-internal keys, never shown
 * on the card, but they ride the reply — so they are capped like the rest. */
const MAX_QUESTION_ID = 200;

/** A protocol questions entry: the id the harness will key its reply by,
 * beside the card question parsed from that same entry. Ids live only in
 * the protocol — the card never sees them. */
export interface ProtocolAskQuestion {
  id: string;
  question: AskQuestion;
}

/** Parse a protocol questions array whose entries carry their own string
 * ids (codex's item/tool/requestUserInput). The same caps and skip rules
 * as parseAskQuestions; an entry without both a usable id and a usable
 * question is skipped rather than fatal, and nothing answerable parses to
 * null. */
export function parseProtocolAskQuestions(entries: unknown): ProtocolAskQuestion[] | null {
  if (!Array.isArray(entries)) return null;
  const parsed: ProtocolAskQuestion[] = [];
  const seenIds = new Set<string>();
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const question = parseQuestion(raw);
    // The id is opaque protocol data echoed back verbatim in the answer, so
    // it is preserved exactly as sent — trimmed only to reject an
    // all-whitespace id — and an overlong id is rejected whole rather than
    // truncated. A duplicate id fails the whole request: two questions
    // cannot share one answer slot, and silently dropping one would ask
    // the person a question whose answer could never be delivered.
    const id = raw.id;
    if (!question || typeof id !== "string" || !id.trim() || id.length > MAX_QUESTION_ID) continue;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    parsed.push({ id, question });
    if (parsed.length === MAX_QUESTIONS) break;
  }
  return parsed.length ? parsed : null;
}

/**
 * The id-keyed counterpart of questionAnswersByQuestion, for a protocol
 * that answers by id (codex's requestUserInput) rather than by question
 * text.
 *
 * Each protocol entry's id is paired with the AskQuestion parsed from that
 * same entry, so a Q:/A: block the card wrote is matched against the text
 * that produced it and filed under the id that asked. Only ids with a real
 * block are answered — a question left unanswered gets no entry rather
 * than a guess. When the reply carries no blocks at all, the flat path
 * applies with exactly one question: the whole message is that question's
 * answer, as it is for a phone or an older client. With more than one,
 * nothing is filed.
 */
export function questionAnswersById(
  message: string,
  questions: readonly ProtocolAskQuestion[],
): Record<string, string> {
  const answers: Record<string, string> = Object.create(null);
  const idByText = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { id, question } of questions) {
    if (idByText.has(question.question)) {
      // Two questions with identical text cannot be told apart in a block;
      // answering either id would be a guess, so neither is answered.
      ambiguous.add(question.question);
      continue;
    }
    idByText.set(question.question, id);
  }
  // A block runs from one Q: header to the next (blank lines inside an
  // answer are the answer's, not block boundaries), so the reply is scanned
  // for header-to-header spans instead of split on every blank line.
  const blocks = message.matchAll(/(?:^|\n\n)Q: ([\s\S]+?)\nA: ([\s\S]*?)(?=\n\nQ: |$)/g);
  let sawBlock = false;
  for (const match of blocks) {
    sawBlock = true;
    const asked = match[1]!.trim();
    if (ambiguous.has(asked)) continue;
    const id = idByText.get(asked);
    const answer = match[2]!.trim();
    // A blank A: is no answer: the id stays unanswered rather than filed
    // as an empty string.
    if (id && answer) answers[id] = answer;
  }
  if (Object.keys(answers).length) return answers;
  // A structured reply that matched a block is authoritative even when it
  // answered nothing: falling through to the flat fallback would file the
  // literal Q:/A: text as the person's answer.
  if (sawBlock) return {};
  const only = questions.length === 1 ? questions[0] : undefined;
  const flat = message.trim();
  return only && flat ? { [only.id]: flat } : {};
}
