import type { PackageDocument } from "../../shared/package-format.js";

export function skillChoicesFrom(value: unknown): string[] | null {
  const skills = (value as { choices?: { skills?: unknown } } | null | undefined)?.choices?.skills;
  return Array.isArray(skills) && skills.every((name) => typeof name === "string") ? skills : null;
}

export function includedSkills(document: PackageDocument): string[] {
  return document.package.skills?.entries.map((entry) => entry.name) ?? [];
}

export function requestedSkills(choice: ReadonlySet<string> | null, available: readonly string[] | null): "all" | string[] {
  if (!choice) return "all";
  return [...choice].filter((name) => !available || available.includes(name));
}

export function startingTicks(result: { document: PackageDocument; skipped: ReadonlyArray<{ part: string; reason: string }> }): string[] {
  const overLimit = new Set(result.skipped.flatMap((skip) => {
    const name = skip.reason === "bot_skill_limit" ? /\.skills\[([^\]]+)\]$/.exec(skip.part)?.[1] : undefined;
    return name ? [name] : [];
  }));
  return includedSkills(result.document).filter((name) => !overLimit.has(name));
}

export function tickedSkills(
  choice: ReadonlySet<string> | null,
  included: readonly string[] | null,
  available: readonly string[] | null,
): Set<string> {
  return new Set(choice ?? included ?? available ?? []);
}
