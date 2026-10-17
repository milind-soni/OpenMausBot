type Requirement = { id?: string; text: string; sourceIds: string[] };

/** Deterministic fixture output must come from the supplied source rows, so
 * preservation tests fail if production omits an earlier user requirement. */
export function fixtureCheckpoint(prompt: string) {
  const rows = prompt.split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const previous = rows.flatMap(row => Array.isArray(row?.requirements) && typeof row?.summary === "string" ? row.requirements : []);
  const requirements: Requirement[] = previous.map((row: Requirement) => ({ ...row, sourceIds: [...row.sourceIds] }));
  for (const row of rows) {
    if (row?.sourceKind !== "user" || row.role !== "user" || typeof row.id !== "string" || typeof row.text !== "string") continue;
    if (!requirements.some(requirement => requirement.sourceIds.includes(row.id))) requirements.push({ text: row.text, sourceIds: [row.id] });
  }
  return {
    objective: requirements[0]?.text ?? "Continue the supplied task",
    requirements,
    retiredRequirements: [], decisions: [], verifiedOutcomes: [], assistantClaims: [], pending: [], criticalContext: [], complete: true,
  };
}
