// Share team…: which skills the dialog asks for and which boxes it ticks.
// Pure and free of the renderer's aliases and DOM, so the server's export
// tests can prove that what the dialog asks for is a choice that fits.
import type { PackageDocument } from "../../shared/package-format.js";

// ── skill choices ──────────────────────────────────────────────────────────
// The first look asks for "all": the server shares the skills that fit and
// lists the rest. Once the person ticks or unticks one, the request names
// exactly the ticked skills, and a choice that cannot fit is refused with a
// sentence. Either way the team's skill names come back, on a refusal too,
// so the boxes never disappear and a refused choice can always be changed.

/** The team's skill names from an export response, or from a refusal's body. */
export function skillChoicesFrom(value: unknown): string[] | null {
  const skills = (value as { choices?: { skills?: unknown } } | null | undefined)?.choices?.skills;
  return Array.isArray(skills) && skills.every((name) => typeof name === "string") ? skills : null;
}

/** The skills a document actually carries. */
export function includedSkills(document: PackageDocument): string[] {
  return document.package.skills?.entries.map((entry) => entry.name) ?? [];
}

/** What to ask for: "all" until the person changes a box, then exactly the
 * ticked skills the team still has (a skill removed meanwhile has no box to
 * untick, so it is never sent). */
export function requestedSkills(choice: ReadonlySet<string> | null, available: readonly string[] | null): "all" | string[] {
  if (!choice) return "all";
  return [...choice].filter((name) => !available || available.includes(name));
}

/** The boxes ticked once "all" has answered: the skills it put in the file,
 * less any name a bot left out over its 30-skill limit. Such a name can be
 * in the file for another bot, but ticked it would be asked for on both and
 * refused. Without those names the ticked list is always a choice that fits,
 * so unticking any box never lands on a refusal. */
export function startingTicks(result: { document: PackageDocument; skipped: ReadonlyArray<{ part: string; reason: string }> }): string[] {
  const overLimit = new Set(result.skipped.flatMap((skip) => {
    const name = skip.reason === "bot_skill_limit" ? /\.skills\[([^\]]+)\]$/.exec(skip.part)?.[1] : undefined;
    return name ? [name] : [];
  }));
  return includedSkills(result.document).filter((name) => !overLimit.has(name));
}

/** Which boxes show ticked: the person's choice, else the starting ticks
 * from "all", else (nothing counted yet) every skill. */
export function tickedSkills(
  choice: ReadonlySet<string> | null,
  included: readonly string[] | null,
  available: readonly string[] | null,
): Set<string> {
  return new Set(choice ?? included ?? available ?? []);
}
