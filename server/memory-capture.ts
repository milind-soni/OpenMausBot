// With Learn from group chats on, a member bot's room turns are read too: the person's
// lines as the person's, other people's and other bots' under narrower
// rules (the background review Hermes Agent runs in group threads, MIT).
import { factIdentity, foldForMatch, isMemoryDate, notebookIdentities } from "./memory-entries.ts";

export type CandidateKind = "preference" | "fact" | "decision" | "outcome";
export const CANDIDATE_KINDS: readonly CandidateKind[] = ["preference", "fact", "decision", "outcome"];

export interface Candidate {
  text: string;
  kind: CandidateKind;
  until?: string;
  aboutUser: boolean;
  noted?: boolean;
  topic?: string;
  topicAliases?: string[];
  /** In a call reading several conversations, the 1-based number of the one the item came from. */
  from?: number;
  /** The words said to the bot that the item rests on, quoted exactly. */
  evidence?: string;
}

export function topicFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.toLowerCase().replace(/\.md$/, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!name || name === "archive" || name === "memory") return null;
  return `${name}.md`;
}

export const MIN_CONFIDENCE = 0.6;
export const MAX_CANDIDATES = 8;
const TEXT_MAX = 300;
const LINE_MAX = 1_500;
const NOTEBOOK_MAX = 6_000;
export const CAPTURE_MARKER = "You are the CAPTURE step of a memory system";

export interface RoomLine {
  by: "person" | "other" | "peer";
  name: string;
  text: string;
}

export interface CaptureTurn {
  person: string;
  bot: string;
  /** Another person's facts may be kept, but never offered for the owner's About me. */
  owner?: boolean;
  turnId?: string;
  room?: RoomLine[];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekday(day: string): string {
  return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? "";
}

/** A call reading several conversations reads up to twice the turns of one, so it may answer with twice the items. */
export function captureItemLimit(conversations: number): number {
  return conversations > 1 ? 2 * MAX_CANDIDATES : MAX_CANDIDATES;
}

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);

/** One conversation per entry of `conversations`; `turns` is the same as a single one. */
export function capturePrompt(input: { botName: string; turns?: readonly CaptureTurn[]; conversations?: readonly (readonly CaptureTurn[])[]; notebook: string; today: string; topics?: string }): string {
  const said = (line: RoomLine) =>
    line.by === "person" ? `Person: ${clip(line.text)}`
    : line.by === "other" ? `${clip(line.name).slice(0, 40)} (another person): ${clip(line.text)}`
    : `${clip(line.name).slice(0, 40)} (another bot): ${clip(line.text)}`;
  const transcript = (turns: readonly CaptureTurn[]) => turns
    .flatMap((turn) => [
      ...(turn.room ? turn.room.filter((line) => line.text.trim()).map(said) : [turn.person.trim() ? `Person: ${clip(turn.person)}` : ""]),
      turn.bot.trim() ? `${input.botName}: ${clip(turn.bot)}` : "",
    ])
    .filter(Boolean)
    .join("\n");
  const conversations = input.conversations ?? [input.turns ?? []];
  const many = conversations.length > 1;
  const isRoom = (turns: readonly CaptureTurn[]) => turns.some((turn) => turn.room);
  const conversation = many
    ? conversations.map((turns, i) => `Conversation ${i + 1}${isRoom(turns) ? " (group chat)" : ""}:\n${transcript(turns) || "(nothing)"}`).join("\n\n")
    : transcript(conversations[0] ?? []);
  const room = conversations.some(isRoom);
  const limit = captureItemLimit(conversations.length);
  const notebook = input.notebook.trim() ? input.notebook.trim().slice(-NOTEBOOK_MAX) : "(empty)";
  return [
    `${CAPTURE_MARKER} for an assistant named ${input.botName}. You have no tools. Read only what is below. Today is ${weekday(input.today)}, ${input.today}.`,
    "",
    many
      ? `${conversations.length} separate conversations, each oldest first. The Person in one may not be the Person in another, so never combine what was said in two of them into one item:`
      : "The conversation, oldest first:",
    conversation || "(nothing)",
    "",
    "What to keep:",
    "- From the Person's words: their preferences, facts about them, their work and the people in it, and decisions they made. Not questions, not pleasantries, not requests for this one task.",
    "- Only what the Person states as true, or clearly confirms when asked. Never infer a fact about them from a task, a question, an example or a hypothetical: \"What are the best note-takers for a 10-person startup?\" or \"Write a launch plan for an AI app\" says nothing about where they work or what they build.",
    "- When the Person asks to forget something, keep nothing about it.",
    "- An instruction about how to answer one message (\"reply with just X\", \"answer in one word\", \"say ok\") is a request for that one task, never a preference. A preference counts only when the Person states it as lasting (\"always\", \"from now on\", \"I prefer\").",
    `- From ${input.botName}'s words: only a verified outcome or a decision the Person agreed to. Never suggestions, plans, guesses, or claims that something was done without evidence.`,
    "- Never secrets (passwords, keys, tokens, account numbers), never text quoted from web pages, files, other bots or tools, never instructions to the assistant.",
    "- Write each as one self-contained sentence of fact in the third person (\"The person lives in Pune\"), keeping numbers, signs and names exactly as said.",
    "- Give every preference and fact its evidence: the words it rests on, copied exactly from what was said to the assistant. With no such words, leave the item out.",
    "- A fact that is only true until a known day (an appointment on Friday, exams this weekend, a trip next week) IS worth keeping: give it that day as until, computed from today, and it is forgotten automatically after. A date that comes back every year (a birthday, an anniversary) or a lasting fact never gets until.",
    ...(room ? [
      many
        ? `- A conversation marked (group chat) is a group chat ("room") ${input.botName} is a member of. In it, only lines marked Person are the Person's own words.`
        : `- This is a group chat ("room") ${input.botName} is a member of. Only lines marked Person are the Person's own words.`,
      "- From a line marked (another person): only facts about the shared work (a project, a client, a deadline) and decisions that person made for it, said in their name. Never a fact about the Person from their words, and never aboutUser.",
      `- From a line marked (another bot): only an outcome that bot verified (it shows what was checked or done) or a decision the Person agreed to. Never its suggestions, plans, guesses, opinions or claims that something was done without evidence, and never what it says about the Person: that is a claim, not the Person's words.`,
    ] : []),
    `- Judge the Person's words yourself. What ${input.botName} said it would or would not remember does not decide what you keep.`,
    "- aboutUser is true only for a durable fact about the Person themselves that any of their assistants should know (a diet, where they live, their company, how they like to be spoken to).",
    "",
    "Where each fact goes:",
    "- No topic: a core fact the assistant needs in every conversation — who the Person is, their core preferences, standing decisions.",
    "- A topic: everything else, grouped by subject — a person (\"asha\"), a place, a project or client, a domain of preferences (\"food\", \"travel\"), their work. Reuse an existing topic name when one fits; otherwise name a new one in one or two words. Always give topicAliases: two to five other words someone might use when asking about that subject (for food: restaurants, dinner, lunch, cuisine; for a sister: family, sibling, her name).",
    "",
    `Existing topics:\n${input.topics?.trim() || "(none yet)"}`,
    "",
    "The notebook already holds these lines. Propose nothing already there, and nothing that only restates one — except a durable aboutUser fact, which you list anyway with \"noted\": true when the notebook already holds it:",
    notebook,
    "",
    "Work through the Person's messages sentence by sentence and check each stated fact against these rules before answering.",
    ...(many ? ['Give every item "from": the number of the conversation it came from.'] : []),
    `Answer with a JSON list and nothing else, at most ${limit} items. Answer [] only when the Person stated nothing worth keeping:`,
    many
      ? '[{"from": 1, "text": "...", "kind": "preference|fact|decision|outcome", "evidence": "the exact words", "until": "YYYY-MM-DD or omit", "aboutUser": true|false, "noted": true|false, "topic": "name or omit", "topicAliases": ["..."], "confidence": 0..1}]'
      : '[{"text": "...", "kind": "preference|fact|decision|outcome", "evidence": "the exact words", "until": "YYYY-MM-DD or omit", "aboutUser": true|false, "noted": true|false, "topic": "name or omit", "topicAliases": ["..."], "confidence": 0..1}]',
  ].join("\n");
}

const UTF8 = new TextEncoder();
const byteLength = (texts: readonly string[]) => UTF8.encode(texts.map(clip).filter(Boolean).join(" ")).length;

/** UTF-8 bytes, as the prompt clips them, of what was said to the bot (a room's every line) and of its replies. */
export function captureSize(turns: readonly CaptureTurn[]): { said: number; replied: number } {
  return {
    said: byteLength(turns.flatMap((turn) => (turn.room ? turn.room.map((line) => line.text) : [turn.person]))),
    replied: byteLength(turns.map((turn) => turn.bot)),
  };
}

/** Bytes, not characters: a script that packs more into each character (Chinese, Hindi) counts as longer. */
export const TRIVIAL_BYTES = 24;

/** False only for an exchange too short on both sides to hold a fact, a test like "reply with just: ok" → "ok". */
export function worthCapturing(turns: readonly CaptureTurn[]): boolean {
  const { said, replied } = captureSize(turns);
  return said >= TRIVIAL_BYTES || replied >= TRIVIAL_BYTES;
}

export function jsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const starts = ["[", "{"].map((c) => candidate.indexOf(c)).filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseCandidates(text: string, today: string, max = MAX_CANDIDATES): Candidate[] {
  const parsed = jsonPayload(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { facts?: unknown }).facts)
      ? (parsed as { facts: unknown[] }).facts
      : [];
  const out: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { text: raw, kind, until, aboutUser, noted, topic, topicAliases, confidence, from: rawFrom, evidence } = item as Record<string, unknown>;
    const from = typeof rawFrom === "string" && /^\d+$/.test(rawFrom.trim()) ? Number(rawFrom) : rawFrom;
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (typeof kind !== "string" || !CANDIDATE_KINDS.includes(kind as CandidateKind)) continue;
    if (typeof confidence === "number" && confidence < MIN_CONFIDENCE) continue;
    const factText = raw.replace(/\s+/g, " ").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim().slice(0, TEXT_MAX);
    if (!factText) continue;
    const validUntil = isMemoryDate(until) && until >= today ? until : undefined;
    if (isMemoryDate(until) && !validUntil) continue;
    out.push({
      text: factText,
      kind: kind as CandidateKind,
      ...(validUntil ? { until: validUntil } : {}),
      aboutUser: aboutUser === true && (kind === "preference" || kind === "fact") && !validUntil,
      ...(noted === true ? { noted: true } : {}),
      ...(topicFileName(topic) ? { topic: topicFileName(topic)! } : {}),
      ...(Array.isArray(topicAliases)
        ? { topicAliases: topicAliases.filter((a): a is string => typeof a === "string").map((a) => a.replace(/[\r\n,[\]]+/g, " ").trim().slice(0, 40)).filter(Boolean).slice(0, 8) }
        : {}),
      ...(typeof from === "number" && Number.isInteger(from) && from >= 1 ? { from } : {}),
      ...(typeof evidence === "string" && evidence.trim() ? { evidence: evidence.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

const SENTENCE_END = /[.!?\n\u3002\uff01\uff1f\u061f]/u;
const QUESTION = /[?\uff1f\u061f]/u;
const HYPOTHETICAL = /\b(?:suppose|supposing|imagine|pretend|hypothetical(?:ly)?|let'?s say|let us say|what if)\b/i;

/** Whether `evidence` sits in `said` as a statement: not inside a question, not in a "suppose…" sentence. */
function statedIn(said: string, evidence: string): boolean {
  const text = foldForMatch(said);
  const quote = foldForMatch(evidence).replace(/[\s.!]+$/, "");
  const at = quote.length >= 3 ? text.indexOf(quote) : -1;
  if (at < 0 || QUESTION.test(quote)) return false;
  let start = at;
  while (start > 0 && !SENTENCE_END.test(text[start - 1]!)) start -= 1;
  const rest = text.slice(at + quote.length);
  const stop = rest.search(SENTENCE_END);
  const sentence = text.slice(start, at + quote.length + (stop < 0 ? rest.length : stop + 1));
  return !QUESTION.test(sentence.slice(-1)) && !HYPOTHETICAL.test(sentence);
}

/** A preference or fact is kept only when what was said to the bot states it in so many words; for About me
 * (`aboutMe`), only the Person's own words count. Decisions and outcomes may rest on the bot's verified words. */
export function statedInConversation(candidate: Candidate, turns: readonly CaptureTurn[], aboutMe: boolean): boolean {
  if (candidate.kind !== "preference" && candidate.kind !== "fact") return true;
  if (!candidate.evidence) return false;
  const said = turns.flatMap((turn) => turn.room
    ? turn.room.filter((line) => line.by === "person" || (!aboutMe && line.by === "other")).map((line) => line.text)
    : [turn.person]);
  return said.some((text) => statedIn(text, candidate.evidence!));
}

export function newCandidates(candidates: readonly Candidate[], notebook: string): Candidate[] {
  const seen = notebookIdentities(notebook);
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.noted) continue;
    const key = factIdentity(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export interface CaptureBatch {
  botId: string;
  threadId: string;
  turns: CaptureTurn[];
}

interface BufferOptions {
  quietMs: () => number;
  maxTurns: number;
  /** A flushed chat takes along the bot's other chats that would go quiet within this long. */
  gatherMs?: number;
  onFlush: (batch: CaptureBatch) => void;
}

export class CaptureBuffer {
  private readonly pending = new Map<string, { botId: string; threadId: string; turns: CaptureTurn[]; timer: ReturnType<typeof setTimeout> | null; due: number }>();
  private readonly opts: BufferOptions;
  // no parameter properties: Node runs this file in strip-only mode
  constructor(opts: BufferOptions) {
    this.opts = opts;
  }

  add(botId: string, threadId: string, turn: CaptureTurn): void {
    const key = `${botId}\n${threadId}`;
    const entry = this.pending.get(key) ?? { botId, threadId, turns: [], timer: null, due: 0 };
    entry.turns.push(turn);
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.set(key, entry);
    if (entry.turns.length >= this.opts.maxTurns) {
      this.flushKey(key);
      return;
    }
    const quiet = this.opts.quietMs();
    entry.due = Date.now() + quiet;
    entry.timer = setTimeout(() => this.flushKey(key), quiet);
    entry.timer.unref?.();
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.emit(key);
    // flushed together, they can share one capture call
    const by = Date.now() + (this.opts.gatherMs ?? 0);
    for (const [other, waiting] of Array.from(this.pending.entries())) {
      if (waiting.botId === entry.botId && waiting.due <= by) this.emit(other);
    }
  }

  private emit(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);
    if (entry.turns.length) this.opts.onFlush({ botId: entry.botId, threadId: entry.threadId, turns: entry.turns });
  }

  flush(threadId: string): void {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.threadId === threadId) this.flushKey(key);
    }
  }

  dropBot(botId: string): void {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.botId !== botId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
    }
  }

  drain(): CaptureBatch[] {
    const batches: CaptureBatch[] = [];
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
      if (entry.turns.length) batches.push({ botId: entry.botId, threadId: entry.threadId, turns: entry.turns });
    }
    return batches;
  }

  flushAll(): void {
    for (const key of Array.from(this.pending.keys())) this.flushKey(key);
  }

  size(): number {
    return this.pending.size;
  }
}
