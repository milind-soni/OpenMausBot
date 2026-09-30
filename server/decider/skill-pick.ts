// Skill pick: which of a bot's enabled skills could help with this message.
// One yes/no per skill (SKILL_PICK in jobs.ts), so each gets its own
// probability.
//
// Acting on it (server/skills.ts): the system prompt lists every skill by
// name only, the same bytes every turn so the prompt cache holds, and the
// full entries of the skills picked here (p >= 0.3, at most 8, likeliest
// first) ride in front of the message. With no usable answer the full
// index rides there instead, so a bot is never worse off than without it.
// Nothing here throws.
import type { Decider } from "./index.ts";
import { SKILL_PICK, perItemProbabilities, perItemQuestions, rankByProbability } from "./jobs.ts";
import { clipList, flatClip } from "./list-state.ts";

export const SKILL_PICK_MIN_PROBABILITY = 0.3;
export const SKILL_PICK_MAX_SKILLS = 8;
export const SKILL_PICK_MESSAGE_CHARS = 1_500;
export const SKILL_PICK_SKILL_CHARS = 300;

export interface SkillPickCandidate {
  name: string;
  description: string;
}

export function skillPickRequest(message: string, skills: readonly SkillPickCandidate[]) {
  const clippedMessage = flatClip(message, SKILL_PICK_MESSAGE_CHARS);
  const list = clipList(
    skills.slice(0, SKILL_PICK.maxItems).map((skill) => `${skill.name}: ${skill.description}`),
    SKILL_PICK_SKILL_CHARS,
    { message: clippedMessage },
  );
  return { state: { message: clippedMessage, skills: list }, questions: perItemQuestions(SKILL_PICK, list.length) };
}

/** The names of the skills that fit, likeliest first, or null when there is
 * nothing to ask or no usable answer (the caller then lists every skill).
 * An empty list is an answer: none fits. */
export async function pickSkills(
  decider: Pick<Decider, "ask">,
  message: string,
  skills: readonly SkillPickCandidate[],
  options: { signal?: AbortSignal } = {},
): Promise<string[] | null> {
  try {
    const asked = skills.slice(0, SKILL_PICK.maxItems);
    if (!message.trim() || !asked.length) return null;
    const { state, questions } = skillPickRequest(message, asked);
    const result = await decider.ask("skillPick", state, questions, { timeoutMs: SKILL_PICK.timeoutMs, signal: options.signal });
    if (!result.ok) return null;
    const probabilities = perItemProbabilities(SKILL_PICK, asked.length, result.answers);
    if (!probabilities) return null;
    return rankByProbability(asked.map((skill, index) => ({ name: skill.name, p: probabilities[index]! })), probabilities)
      .filter((skill) => skill.p >= SKILL_PICK_MIN_PROBABILITY)
      .slice(0, SKILL_PICK_MAX_SKILLS)
      .map((skill) => skill.name);
  } catch {
    return null;
  }
}
