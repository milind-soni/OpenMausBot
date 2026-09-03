export interface SearchableSkill {
  id: string;
  name: string;
  description: string;
  origin: "built-in" | "recorded" | "imported";
  source?: string;
}

export const MAX_SELECTED_SKILLS = 8;

export function skillSelectionSummary(availableCount: number, selectedCount: number): string {
  return `${availableCount} available · ${selectedCount} selected · max ${MAX_SELECTED_SKILLS} per send`;
}

/** `/skills` is a local composer command, never prompt text. Optional text
 * after it seeds the dialog search. Other slash commands remain untouched. */
export function skillsCommandQuery(text: string): string | null {
  const match = text.match(/^\s*\/skills(?:\s+([^\n]*))?\s*$/iu);
  return match ? (match[1]?.trim() ?? "") : null;
}

/** Return skills matching every whitespace-delimited query term across their
 * searchable metadata. */
export function searchSkills<T extends SearchableSkill>(skills: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...skills];
  return skills.filter((skill) => {
    const haystack = [skill.id, skill.name, skill.description, skill.origin, skill.source ?? ""].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function selectedSkillsByIds<T extends { id: string }>(skills: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return [...new Set(ids)].slice(0, MAX_SELECTED_SKILLS).map((id) => byId.get(id)).filter((skill): skill is T => Boolean(skill));
}

/** Legacy scalar helper kept for older callers while the composer uses the batch form. */
export function selectedSkillById<T extends { id: string }>(skills: readonly T[], id: string | null): T | null {
  return id ? selectedSkillsByIds(skills, [id])[0] ?? null : null;
}

export function toggleSkillId(current: readonly string[], id: string): string[] {
  const unique = [...new Set(current)].slice(0, MAX_SELECTED_SKILLS);
  if (unique.includes(id)) return unique.filter((candidate) => candidate !== id);
  if (unique.length >= MAX_SELECTED_SKILLS) return unique;
  return [...unique, id];
}

/** A late accepted response may only clear the selection it actually sent. */
export function clearAcceptedSkills(current: readonly string[], accepted: readonly string[] | undefined): string[] {
  if (!accepted?.length) return [...current];
  const sent = new Set(accepted);
  return current.filter((id) => !sent.has(id));
}

/** Legacy scalar helper kept for old integrations. */
export function clearAcceptedSkill(current: string | null, accepted: string | undefined): string | null {
  return accepted && current === accepted ? null : current;
}

export function skillOriginLabel(origin: SearchableSkill["origin"]): string {
  if (origin === "built-in") return "Built in";
  if (origin === "recorded") return "Recorded";
  return "Imported";
}
