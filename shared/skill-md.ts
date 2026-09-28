// SKILL.md reading shared by the server skill store, the package format and
// the renderer. Pure text only: no filesystem, no Node globals, so the same
// rules validate a skill wherever it is read (server/skills.ts re-exports
// these under their historical names).

/** Spec rule: lowercase alphanumerics with single hyphens, 1-64 chars,
 * folder name must equal it. The regex IS the traversal gate — no dots, no
 * slashes, no way to name a skill "..". */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
/** One SKILL.md may be at most this large; the spec recommends <5k tokens. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;

export function isSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= SKILL_NAME_MAX && SKILL_NAME.test(name);
}

export interface ParsedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  body: string;
}

/** Minimal frontmatter reader for the two required keys plus the two we
 * display. Deliberately not a YAML engine: values are single-line strings in
 * every skill the spec's own examples show, and a parser that cannot
 * evaluate anchors or tags cannot be surprised by them. */
export function parseSkillMd(raw: string): ParsedSkill | { error: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { error: "SKILL.md has no YAML frontmatter (--- block) at the top" };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (!isSkillName(name)) {
    return { error: `frontmatter name ${JSON.stringify(name)} is not a valid skill name (lowercase, hyphens, max ${SKILL_NAME_MAX})` };
  }
  if (!description || description.length > DESCRIPTION_MAX) {
    return { error: `frontmatter description is required and must be at most ${DESCRIPTION_MAX} characters` };
  }
  return {
    name,
    description,
    license: fields.license || undefined,
    compatibility: fields.compatibility || undefined,
    body: match[2] ?? "",
  };
}

/** Static red flags before a human review. Presence is a warning shown in
 * the review screen, never a silent rejection — the reviewer decides. These
 * are the three patterns the public registry audits actually caught. */
export function scanSkillText(raw: string): string[] {
  const warnings: string[] = [];
  if (/[A-Za-z0-9+/]{120,}={0,2}/.test(raw)) {
    warnings.push("contains a long base64-looking blob — a common wrapper for hidden instructions or payloads");
  }
  if (/\b(curl|wget)\b[^\n]{0,200}\|\s*(ba|z|da)?sh\b/.test(raw)) {
    warnings.push("pipes a download straight into a shell (curl|sh) — never enable without understanding why");
  }
  // zero-width and bidi-control characters hide text from the reviewer while
  // the model still reads it — the invisible-instruction trick
  if (/[​-‏‪-‮⁠-⁤﻿]/.test(raw)) {
    warnings.push("contains invisible Unicode characters (zero-width or bidi controls) — text you cannot see");
  }
  return warnings;
}
