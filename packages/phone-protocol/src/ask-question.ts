/**
 * Structured questions from a provider's own "ask the human" tool, Claude
 * Code's `AskUserQuestion`. The CLI routes it through --permission-prompt-tool
 * like any tool use, so it is re-read here into the questions posed. The
 * payload is bot-authored: validated rather than cast, and capped.
 */

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
export const QUESTION_DISMISS_MESSAGE = "The user closed this question without answering. Use your best judgment and continue.";

/** Claude Code's own limits are 1-4 questions and 2-4 options; these leave
 * room for a provider that widens them. */
export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 12;
export const MAX_QUESTION_TEXT = 8_000;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 400;
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
  /** false when the provider can only take an option back (an ACP
   * permission-style question answers with an option id): no free text. */
  custom?: false;
}

export interface QuestionRequestCardData {
  version: 1;
  questions: AskQuestion[];
  /** "tool" (or absent): a real tool call; "output": a block parsed from
   * model-authored output. Only drives the agent-composed badge. */
  origin?: "tool" | "output";
}

/** Excludes the other durable proposal card kinds that share requestId. */
export function isPersistentQuestionCard(card?: {
  requestType?: "permission" | "question";
  questionRequest?: unknown;
  tool?: string;
  routineRequest?: unknown;
  skillRequest?: unknown;
  profileRequest?: unknown;
  modelRequest?: unknown;
  teamSetupRequest?: unknown;
} | null): boolean {
  return Boolean(card && (
    card.requestType === "question" || card.questionRequest ||
    (!card.requestType && !card.tool && !card.routineRequest && !card.skillRequest && !card.profileRequest &&
      !card.modelRequest && !card.teamSetupRequest)
  ));
}

/** System/provider completion ends the live run, not the human's question. */
export function shouldSettleRequestCard(card: Parameters<typeof isPersistentQuestionCard>[0], source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer"): boolean {
  return !isPersistentQuestionCard(card) || source === "user";
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
  // Not the documented shape, but accepted.
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
    // Duplicate labels: the answer text could not say which row was picked.
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  // An empty option list is kept: the card always offers free text.
  const header = text(value.header, MAX_LABEL);
  return {
    question,
    ...(header ? { header } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    options,
    // only meaningful beside options: with none, free text is the only answer
    ...(value.custom === false && options.length ? { custom: false as const } : {}),
  };
}

/** null when the payload is not one; a malformed call gets the ordinary card. */
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

/** Codex request_user_input_async's `{ title, options: string[] | null }` entries in the card's shape. Null unless one
 * offers an option: a bare question already reads in the message text. */
export function parseAsyncQuestions(entries: unknown): AskQuestion[] | null {
  if (!Array.isArray(entries)) return null;
  const questions = parseAskQuestions({
    questions: entries.map((entry) => (isRecord(entry) ? { question: entry.title, options: entry.options } : null)),
  });
  return questions?.some((question) => question.options.length > 0) ? questions : null;
}

/** The one line the card subtitle and a spoken prompt show. */
export function askQuestionSummary(questions: readonly AskQuestion[]): string {
  const first = questions[0]?.question ?? "";
  const rest = questions.length - 1;
  return rest > 0 ? `${first} (+${rest} more question${rest > 1 ? "s" : ""})` : first;
}

/** The tool advertises "2-5 suggested answers". */
export const MAX_CHOICES = 5;

/**
 * A model that has seen AskUserQuestion may hand over `{ label, description }`
 * rows instead of strings (MiniMax M3 does). Anything else is dropped: React
 * refuses a non-string child.
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

/** For clients that only render a list of choices: only a single question can
 * be answered that way. */
export function questionChoices(questions: readonly AskQuestion[]): string[] | undefined {
  if (questions.length !== 1) return undefined;
  const only = questions[0]!;
  if (only.multiSelect || only.options.length < 2) return undefined;
  return only.options.map((option) => option.label);
}

/** The chat runtime's ask tool. Named ask_user so the ASKS_A_PERSON backstop
 * covers it: no auto mode may answer a question. */
export const ASK_USER_TOOL = "ask_user";

/** Shaped for an OpenAI function-calling tool list. The parser enforces the caps
 * again: a model-authored argument is not a guarantee it followed the schema. */
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

/** The answer is delivered on the deny channel, so it says what it is; the card
 * strips it back off for display. */
export const ANSWER_PREAMBLE = "The user answered your questions.";
const JSON_ANSWERS_PREFIX = `${ANSWER_PREAMBLE}\n\nAnswers (JSON):\n`;

/** Arrives as the tool's result, so it names each question and what was picked. */
export function formatQuestionAnswers(
  questions: readonly AskQuestion[],
  answers: readonly (readonly string[])[],
): string {
  const pairs: [string, string][] = [];
  questions.forEach((question, index) => {
    const picked = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean);
    if (!picked.length) return;
    pairs.push([question.question, picked.join(", ")]);
  });
  if (!pairs.length) return "";
  // Newlines can contain Q:/A: headers; JSON preserves them as answer text.
  if (pairs.some(pair => pair.some(value => /[\r\n]/.test(value)))) {
    return JSON_ANSWERS_PREFIX + JSON.stringify(pairs);
  }
  return `${ANSWER_PREAMBLE}\n\n${pairs.map(([question, answer]) => `Q: ${question}\nA: ${answer}`).join("\n\n")}`;
}

export function answerWithoutPreamble(answer: string): string {
  return answer.startsWith(`${ANSWER_PREAMBLE}\n\n`) ? answer.slice(ANSWER_PREAMBLE.length + 2) : answer;
}

/** Sized so a reply typed in a card is never cut; only a longer chat message echoed back as free text is. */
export const MAX_ANSWER_ECHO = ANSWER_PREAMBLE.length + MAX_QUESTIONS
  * ("\n\nQ: \nA: ".length + MAX_QUESTION_TEXT + MAX_OPTIONS * (MAX_LABEL + ", ".length) + MAX_CUSTOM_ANSWER);

/** Cut back to the last whole block, so no partial answer reads as one. */
export function capAnswerEcho(answer: string, limit = MAX_ANSWER_ECHO): string {
  if (answer.length <= limit) return answer;
  const cut = answer.slice(0, limit);
  const boundary = cut.lastIndexOf("\n\nQ: ");
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return kept + "\n\n[answer truncated]";
}

/**
 * The card sends one answer for the whole set; `formatQuestionAnswers` writes
 * each question's text beside its answer, so the map is recovered rather than
 * guessed. A message with no blocks is filed only when there is exactly one
 * question.
 */
export function questionAnswersByQuestion(
  message: string,
  questions: readonly AskQuestion[],
): Record<string, string> {
  return questionAnswersById(message, questions.map(question => ({ id: question.question, question })));
}

/**
 * One answer read back as picked option labels plus the person's own words, for a protocol that answers by option.
 * The card joins multi-select labels with ", " and a label may contain ", ": every reading is tried, a reading that
 * is labels end to end wins, and when the best readings disagree the whole answer is own words, never a guessed option.
 */
export function pickedOptionLabels(answer: string, question: AskQuestion): { labels: string[]; other?: string } {
  const text = answer.trim();
  const labels = question.options.map((option) => option.label);
  if (!question.multiSelect) {
    if (labels.includes(text)) return { labels: [text] };
    return text ? { labels: [], other: text } : { labels: [] };
  }
  const whole: string[][] = [];
  const partial: Array<{ labels: string[]; other: string }> = [];
  const read = (rest: string, picked: string[]): void => {
    const next = labels.filter((label) => !picked.includes(label) && (rest === label || rest.startsWith(`${label}, `)));
    if (!next.length) {
      if (rest) partial.push({ labels: picked, other: rest });
      else whole.push(picked);
      return;
    }
    for (const label of next) read(rest.slice(label.length + 2), [...picked, label]);
  };
  read(text, []);
  const key = (reading: { labels: string[]; other?: string }) => JSON.stringify([[...reading.labels].sort(), reading.other ?? null]);
  const readings = whole.length ? whole.map((picked) => ({ labels: picked })) : partial;
  const first = readings[0]!;
  const agree = readings.every((reading) => key(reading) === key(first));
  return agree ? first : { labels: [], other: text };
}

/** Ids ride the reply, so they are capped like the rest. */
const MAX_QUESTION_ID = 200;

/** Ids live only in the protocol; the card never sees them. */
export interface ProtocolAskQuestion {
  id: string;
  question: AskQuestion;
}

/** Entries carry their own string ids (codex's item/tool/requestUserInput). An
 * entry without a usable id and question is skipped; nothing answerable parses
 * to null. */
export function parseProtocolAskQuestions(entries: unknown): ProtocolAskQuestion[] | null {
  if (!Array.isArray(entries)) return null;
  const parsed: ProtocolAskQuestion[] = [];
  const seenIds = new Set<string>();
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const question = parseQuestion(raw);
    // Echoed back verbatim, so preserved exactly and an overlong id rejected
    // whole. A duplicate id fails the request: two questions cannot share one
    // answer slot.
    const id = raw.id;
    if (!question || typeof id !== "string" || !id.trim() || id.length > MAX_QUESTION_ID) continue;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    parsed.push({ id, question });
    if (parsed.length === MAX_QUESTIONS) break;
  }
  return parsed.length ? parsed : null;
}

/** A card reply answers by question text, so it cannot tell two questions with the same text apart. */
export function repeatsQuestionText(questions: readonly ProtocolAskQuestion[]): boolean {
  return new Set(questions.map(({ question }) => question.question)).size !== questions.length;
}

/**
 * Answers by id (codex's requestUserInput). Only ids with a real block are
 * answered; without blocks, the whole message answers a lone question.
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
      // Identical question text cannot be told apart in a block: neither is answered.
      ambiguous.add(question.question);
      continue;
    }
    idByText.set(question.question, id);
  }
  if (message.startsWith(JSON_ANSWERS_PREFIX)) {
    let pairs: unknown;
    try { pairs = JSON.parse(message.slice(JSON_ANSWERS_PREFIX.length)); }
    catch { return {}; }
    if (!Array.isArray(pairs) || !pairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string"))) return {};
    for (const [asked, answer] of pairs as [string, string][]) {
      const id = idByText.get(asked);
      if (id && !ambiguous.has(asked) && answer.trim()) answers[id] = answer;
    }
    return answers;
  }
  // A block runs from one Q: header to the next; blank lines inside an answer
  // are the answer's.
  const blocks = message.matchAll(/(?:^|\n\n)Q: ([\s\S]+?)\nA: ([\s\S]*?)(?=\n\nQ: |$)/g);
  let sawBlock = false;
  for (const match of blocks) {
    sawBlock = true;
    const asked = match[1]!.trim();
    if (ambiguous.has(asked)) continue;
    const id = idByText.get(asked);
    const answer = match[2]!.trim();
    // A blank A: is no answer.
    if (id && answer) answers[id] = answer;
  }
  if (Object.keys(answers).length) return answers;
  // A reply that matched a block is authoritative even when it answered
  // nothing, or the literal Q:/A: text would be filed as the answer.
  if (sawBlock) return {};
  const only = questions.length === 1 ? questions[0] : undefined;
  const flat = message.trim();
  return only && flat ? { [only.id]: flat } : {};
}
