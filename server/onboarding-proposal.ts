export const onboardingPurposes = ["Development", "Design", "Research", "Finance", "Custom"] as const;

export function validOnboardingGoal(purposes: unknown, customGoal: unknown): purposes is typeof onboardingPurposes[number][] {
  return Array.isArray(purposes) && purposes.length > 0 && new Set(purposes).size === purposes.length
    && purposes.every((purpose) => onboardingPurposes.includes(purpose))
    && typeof customGoal === "string" && customGoal.length <= 500
    && (!purposes.includes("Custom") || Boolean(customGoal.trim()));
}

function field(value: unknown, limit: number): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed.length <= limit ? trimmed : null;
}

export function readBuddyDetails(value: unknown, names: Set<string>) {
  if (!value || typeof value !== "object") return null;
  const { name, title, description } = value as Record<string, unknown>;
  const cleanName = field(name, 48);
  const cleanTitle = field(title, 80);
  const cleanDescription = field(description, 2400);
  if (!cleanName || !cleanTitle || !cleanDescription || names.has(cleanName.toLowerCase())) return null;
  names.add(cleanName.toLowerCase());
  return { name: cleanName, title: cleanTitle, description: cleanDescription };
}

function hasInstructions(description: string) {
  const [role, personality, rulesHeader, ...body] = description.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const closingLine = body.pop();
  return /^Role: \S/.test(role ?? "") && /^Personality & Task: \S/.test(personality ?? "")
    && rulesHeader === "Rules:" && body.length >= 4 && body.every((line) => /^- \S/.test(line))
    && Boolean(closingLine && !/^[-*]/.test(closingLine));
}

export function parseSuggestedTeam(value: unknown) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 6) return null;
  const names = new Set<string>();
  const team: Array<{ name: string; title: string; description: string; reason: string }> = [];
  for (const buddy of value) {
    const details = readBuddyDetails(buddy, names);
    const reason = field(buddy?.reason, 500);
    if (!details || !reason || !hasInstructions(details.description)) return null;
    team.push({ ...details, reason });
  }
  return team;
}

export function decodeGeneratedTeam(text: string) {
  const response = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(response);
  try {
    return parseSuggestedTeam(JSON.parse(fenced?.[1] ?? response));
  } catch {
    return null;
  }
}
