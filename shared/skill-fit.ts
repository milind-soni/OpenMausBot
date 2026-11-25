// Which of many skills fit a bot or a task, by the words they share. A word in a skill's name counts twice one in its
// description, a word few skills use counts more than one most of them use, and a long description earns no more than a
// short one. No model call: the same words always pick the same skills, so a bot's list holds still between turns and
// its prompt stays cached.

export interface FitSkill {
  name: string;
  description: string;
}

const COMMON = new Set([
  "about", "after", "also", "and", "any", "are", "can", "does", "each", "for", "from", "has", "have", "how", "into", "its",
  "not", "one", "skill", "that", "the", "their", "them", "then", "this", "use", "used", "user", "using", "was", "what",
  "when", "which", "who", "will", "with", "you", "your",
]);

/** Lowercased words of three letters or more, a plural "s" dropped and cut to six letters, so "invoices", "invoicing"
 * and "invoice" meet. */
export function fitWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) => {
    if (word.length < 3 || COMMON.has(word)) return [];
    const single = word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
    return [single.slice(0, 6)];
  });
}

/** The skills that share a word with `about`, best first; a skill that shares none is left out. */
export function rankSkills<T extends FitSkill>(skills: readonly T[], about: string): T[] {
  const wanted = new Set(fitWords(about));
  if (!wanted.size || !skills.length) return [];
  const docs = skills.map((skill) => {
    const weights = new Map<string, number>();
    for (const word of fitWords(skill.description)) weights.set(word, 1);
    for (const word of fitWords(skill.name.replace(/-/g, " "))) weights.set(word, 2);
    return weights;
  });
  const usedBy = new Map<string, number>();
  for (const doc of docs) for (const word of doc.keys()) usedBy.set(word, (usedBy.get(word) ?? 0) + 1);
  const averageSize = docs.reduce((sum, doc) => sum + doc.size, 0) / docs.length || 1;
  return skills
    .map((skill, i) => {
      const doc = docs[i]!;
      let score = 0;
      for (const [word, weight] of doc) if (wanted.has(word)) score += weight * Math.log(1 + skills.length / usedBy.get(word)!);
      return { skill, score: score / (0.5 + (0.5 * doc.size) / averageSize) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((hit) => hit.skill);
}
