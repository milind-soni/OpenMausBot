// Every job the decision model does, beyond room routing (room-routing.ts):
// the exact question each one asks, the state keys it may send, how long a
// caller waits, and whether the job is on before anyone touches its switch.
//
// One contract per job, used in three places: the job's own module builds
// its request from these constants, relay.ts checks every request that would
// go through Cloud Pro's included token against them, and the Admin's relay
// (openmaus-cloud, DECIDER_CONTRACT) holds the same text. Changing a question
// here means changing it there, or Pro homes stop getting that job.
//
// Two shapes:
// - "single": one question with id `answer`. Its instructions are fixed; a
//   choice may have fixed options (checked exactly) or options the caller
//   supplies (checked only for count and size); a score has fixed levels.
// - "perItem": one yes/no question per entry of a list in the state, ids
//   `<prefix>0` … `<prefix>n-1`, each with the fixed instructions for its
//   index. That is how a list is ranked: every entry gets its own calibrated
//   probability, where one choice would only name a winner.
//
// Jev reads literally (docs.typesafe.ai jaggedness notes): the instructions
// name the exact state paths and say what counts, and nothing asks it to
// count, compare dates or do arithmetic.
import type { DeciderJob } from "./types.ts";

interface ContractBase {
  job: Exclude<DeciderJob, "roomRouting">;
  /** The state keys a request may carry; `required` must all be present. */
  stateKeys: readonly string[];
  required: readonly string[];
  /** On before anyone switches it: jobs that only add information are on,
   * jobs that change what a bot sees or does start off. */
  defaultOn: boolean;
  /** How long the caller waits. Jobs on a person's path are short; jobs that
   * run after the fact can wait longer. */
  timeoutMs: number;
}

export interface SingleContract extends ContractBase {
  kind: "single";
  type: "choice" | "score" | "yesno";
  instructions: string;
  /** A choice whose options never change. Absent: the caller supplies them. */
  options?: Readonly<Record<string, string>>;
  /** A score's levels, lowest first. */
  levels?: readonly string[];
}

export interface PerItemContract extends ContractBase {
  kind: "perItem";
  /** The state key holding the list; one yes/no question per entry. */
  listKey: string;
  idPrefix: string;
  maxItems: number;
  instructionsFor(index: number): string;
}

export type JobContract = SingleContract | PerItemContract;

// ── 2. Memory recall ────────────────────────────────────────────────────────
// Keyword search (SQLite FTS5) finds the candidates; Jev reorders them by
// meaning. Fallback: the keyword order.
export const MEMORY_RECALL: PerItemContract = {
  job: "memoryRecall",
  kind: "perItem",
  listKey: "candidates",
  idPrefix: "c",
  maxItems: 24,
  instructionsFor: (index) => `Does \`candidates[${index}]\` contain information that helps answer \`query\`?`,
  stateKeys: ["query", "candidates"],
  required: ["query", "candidates"],
  defaultOn: true,
  timeoutMs: 1_200,
};

// ── 3. Skill pick ───────────────────────────────────────────────────────────
// Which enabled skills could help with this message. Fallback: the full
// index, as today.
export const SKILL_PICK: PerItemContract = {
  job: "skillPick",
  kind: "perItem",
  listKey: "skills",
  idPrefix: "s",
  maxItems: 60,
  instructionsFor: (index) => `Could the skill \`skills[${index}]\` help the bot handle \`message\`?`,
  stateKeys: ["message", "skills"],
  required: ["message", "skills"],
  defaultOn: false,
  timeoutMs: 1_200,
};

// ── 4. Tool pick ────────────────────────────────────────────────────────────
// Which connected-app tools this message might need. Fallback: every tool.
export const TOOL_PICK: PerItemContract = {
  job: "toolPick",
  kind: "perItem",
  listKey: "tools",
  idPrefix: "t",
  maxItems: 120,
  instructionsFor: (index) => `Might the bot need the tool \`tools[${index}]\` to handle \`message\`?`,
  stateKeys: ["message", "tools"],
  required: ["message", "tools"],
  defaultOn: false,
  timeoutMs: 1_500,
};

// ── 5. Task outcome ─────────────────────────────────────────────────────────
// Did a routine that ended "ok" actually get its task done? Fallback: the
// engine's own ok.
export const TASK_OUTCOME: SingleContract = {
  job: "taskOutcome",
  kind: "single",
  type: "choice",
  instructions: "What does `final_reply` say happened to the task in `task`?",
  options: {
    done: "Done: the reply reports the task was carried out, or reports its result.",
    blocked: "Not done: the reply says the task could not be finished or was only partly done, for example a sign-in failed, a site or file was unavailable, access was missing, or it needs the person to do something.",
    nothing: "Nothing to do: the reply says there was nothing new or nothing that needed doing this time.",
  },
  stateKeys: ["task", "final_reply"],
  required: ["task", "final_reply"],
  defaultOn: true,
  timeoutMs: 5_000,
};

// ── 6. Risk check ───────────────────────────────────────────────────────────
// Before a tool call is approved automatically: how risky is it to run
// unchecked? Only ever turns an automatic approval into a question for the
// person; never approves anything. Fallback: today's verdict.
export const RISK_CHECK: SingleContract = {
  job: "riskCheck",
  kind: "single",
  type: "score",
  instructions: "How risky is it for the bot to run `action` without a person checking it first?",
  levels: [
    "Low: it only reads or looks at things, or makes a small change on this computer that is easy to undo.",
    "Medium: it changes files, settings or data on this computer in a way that takes effort to undo, but affects nobody else.",
    "High: it sends, posts, publishes, pays, buys, deletes or shares something, or changes accounts or permissions, affecting other people, money or data that cannot easily be recovered.",
  ],
  stateKeys: ["action", "task"],
  required: ["action"],
  defaultOn: true,
  timeoutMs: 1_500,
};

// ── 7. Correction or new request ────────────────────────────────────────────
// A message sent while a bot is busy: part of the running task, or a
// separate request? Fallback: steer or queue, as today.
export const STEER_SPLIT: SingleContract = {
  job: "steerSplit",
  kind: "single",
  type: "choice",
  instructions: "Is `new_message` about the task described in `running_task`, or a separate request?",
  options: {
    same: "About the running task: it adds to, corrects, narrows, redirects or stops that task, or answers something the bot asked about it.",
    separate: "A separate request: it asks for something unrelated to the running task that could be done on its own afterwards.",
  },
  stateKeys: ["running_task", "new_message"],
  required: ["running_task", "new_message"],
  defaultOn: false,
  timeoutMs: 800,
};

// ── 8. Stuck check ──────────────────────────────────────────────────────────
// After the repeat detector fires: is the bot actually stuck? Only reports;
// never stops a turn. Fallback: today's repeat chip.
export const STUCK_CHECK: SingleContract = {
  job: "stuckCheck",
  kind: "single",
  type: "yesno",
  instructions: "Is the bot stuck: repeating the same steps in `recent_steps` without getting closer to finishing `task`?",
  stateKeys: ["task", "recent_steps"],
  required: ["recent_steps"],
  defaultOn: true,
  timeoutMs: 5_000,
};

// ── 9. Notification urgency ─────────────────────────────────────────────────
// Buzz now, or arrive quietly? Only ever quietens a notification that would
// have made a sound; never makes a silent one loud. Fallback: as today.
export const NOTIFY_URGENCY: SingleContract = {
  job: "notifyUrgency",
  kind: "single",
  type: "choice",
  instructions: "Does the person need to see `notification` soon?",
  options: {
    urgent: "Soon: something failed or is blocked, a bot is waiting on the person, or the news is time-sensitive.",
    later: "Later: a finished task, a routine update or information the person can read whenever they next look.",
  },
  stateKeys: ["notification"],
  required: ["notification"],
  defaultOn: true,
  timeoutMs: 1_500,
};

// ── 10. Where work runs ─────────────────────────────────────────────────────
// Only when the bot's "Works on" is Auto and the conversation is not pinned:
// which of the places actually available fits this message. The caller
// supplies the options (only places that exist here). Fallback: today's
// automatic order.
export const WORK_PLACE: SingleContract = {
  job: "workPlace",
  kind: "single",
  type: "choice",
  instructions: "Where should the bot do the work `message` asks for?",
  stateKeys: ["message", "bot"],
  required: ["message"],
  defaultOn: false,
  timeoutMs: 1_200,
};

// ── 11. Model routing ───────────────────────────────────────────────────────
// How much work a message needs, so an easy one can go to the engine's
// lighter model. Fallback: the bot's own model.
export const MODEL_ROUTING: SingleContract = {
  job: "modelRouting",
  kind: "single",
  type: "score",
  instructions: "How much thinking and work does the bot need to handle `message` well?",
  levels: [
    "Light: a greeting, a quick fact, a short rewrite or a simple question with one clear answer.",
    "Moderate: a few steps, some judgement, or a short piece of writing or code.",
    "Heavy: a multi-step task, careful reasoning, research, a long document or real code changes.",
  ],
  stateKeys: ["message", "recent_messages"],
  required: ["message"],
  defaultOn: false,
  timeoutMs: 1_000,
};

// ── 12. Browser clicks ──────────────────────────────────────────────────────
// The bot names what to click in words; Jev picks the element from the page
// snapshot. The caller supplies the options (the page's element refs).
// Fallback: the tool reports it could not tell, and the bot clicks by ref.
export const BROWSER_CLICK: SingleContract = {
  job: "browserClick",
  kind: "single",
  type: "choice",
  instructions: "Which element on `page` is the one `target` describes?",
  stateKeys: ["target", "page"],
  required: ["target"],
  defaultOn: false,
  timeoutMs: 3_000,
};

export const JOB_CONTRACTS: Readonly<Record<Exclude<DeciderJob, "roomRouting">, JobContract>> = {
  memoryRecall: MEMORY_RECALL,
  skillPick: SKILL_PICK,
  toolPick: TOOL_PICK,
  taskOutcome: TASK_OUTCOME,
  riskCheck: RISK_CHECK,
  steerSplit: STEER_SPLIT,
  stuckCheck: STUCK_CHECK,
  notifyUrgency: NOTIFY_URGENCY,
  workPlace: WORK_PLACE,
  modelRouting: MODEL_ROUTING,
  browserClick: BROWSER_CLICK,
};

/** Whether a job is on before its switch is touched. */
export function jobDefaultOn(job: DeciderJob): boolean {
  if (job === "roomRouting") return true;
  return (JOB_CONTRACTS as Partial<Record<string, JobContract>>)[job]?.defaultOn ?? false;
}

/** The questions a perItem job asks for a list of `count` entries. */
export function perItemQuestions(contract: PerItemContract, count: number) {
  const questions: Record<string, { type: "yesno"; instructions: string }> = {};
  for (let index = 0; index < count; index++) {
    questions[`${contract.idPrefix}${index}`] = { type: "yesno", instructions: contract.instructionsFor(index) };
  }
  return questions;
}

/** The yes-probability of each entry, in list order, from a perItem answer.
 * Null when any entry is missing: the caller keeps its own order. */
export function perItemProbabilities(
  contract: PerItemContract,
  count: number,
  answers: Record<string, { type: string; p?: number }>,
): number[] | null {
  const out: number[] = [];
  for (let index = 0; index < count; index++) {
    const answer = answers[`${contract.idPrefix}${index}`];
    if (!answer || answer.type !== "yesno" || typeof answer.p !== "number") return null;
    out.push(answer.p);
  }
  return out;
}

/** Stable reorder by probability, highest first; ties keep their input
 * order, so a flat answer changes nothing. */
export function rankByProbability<T>(items: readonly T[], probabilities: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, index, p: probabilities[index] ?? 0 }))
    .sort((a, b) => b.p - a.p || a.index - b.index)
    .map(({ item }) => item);
}

/** Caller-supplied choice options: keys and meanings within these sizes. */
export const OPTION_KEY_MAX = 128;
export const OPTION_TEXT_MAX = 600;
