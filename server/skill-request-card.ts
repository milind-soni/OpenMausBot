import { createHash } from "node:crypto";

import { redactSecretsInText } from "./redact.ts";
import { fetchSkillFromSource } from "./skill-fetch.ts";
import { isSkillReferencePath, MAX_SKILL_REFERENCES, STAGED_SKILL_REFERENCE_MAX_BYTES } from "./skill-storage.ts";
import { listSkills, readSkillFile, readSkillReferences, STAGED_GIST_MAX } from "./skills.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";

type SkillFile = { path: string; content: string };

export function skillCardCopy(staged: {
  action: "create" | "update";
  name: string;
  gist: string;
  warnings: string[];
  files?: Array<{ path: string }>;
}): { title: string; subtitle: string; tool: string } {
  const warnings = staged.warnings.length ? `\n\nWarnings:\n- ${staged.warnings.join("\n- ")}` : "";
  const references = (staged.files ?? []).filter((file) => file.path !== "SKILL.md").length;
  const referenceNote = references ? ` It keeps ${references} reference file${references === 1 ? "" : "s"} the bot reads when needed.` : "";
  return {
    title: staged.action === "create"
      ? `Enable skill "${staged.name}"?`
      : `Update skill "${staged.name}"?`,
    subtitle: `${staged.gist || staged.name}\n\nAdds one line to the prompt index; the body is read only when used.${referenceNote}${warnings}`,
    tool: "stage_skill",
  };
}

/** The installed version an update replaces, for Undo; undefined when it cannot be restored exactly. */
export function previousSkillVersion(botId: string, staged: { action: "create" | "update"; name: string }): SkillRequestCardData["previous"] {
  if (staged.action !== "update") return undefined;
  const preview = readSkillFile(botId, staged.name);
  const references = readSkillReferences(botId, staged.name);
  const source = listSkills(botId).find((skill) => skill.name === staged.name)?.source;
  if (preview === null || references === null || !source) return undefined;
  return { preview, source, ...(references.length ? { references } : {}) };
}

export function skillRequestReferences(staged: { files: SkillFile[]; referencesSha256?: string }): Pick<SkillRequestCardData, "references" | "referencesSha256"> {
  if (!staged.referencesSha256) return {};
  return { references: staged.files.filter((file) => file.path !== "SKILL.md"), referencesSha256: staged.referencesSha256 };
}

export function parseSkillManageReferences(value: unknown): SkillFile[] | { error: string } {
  const references = value === undefined ? [] : value;
  const valid = Array.isArray(references) && references.every((file): file is SkillFile =>
    Boolean(file) && typeof file === "object" && typeof (file as { path?: unknown }).path === "string" &&
    typeof (file as { content?: unknown }).content === "string");
  if (!valid) return { error: 'references must be a list of { path: "references/<topic>.md", content } objects' };
  return references.map((file) => ({ path: file.path.trim(), content: file.content }));
}

/**
 * skill_manage action "import": fetch the skill the way the Skills page Import box does (HTTPS from the app, no git on
 * the person's computer) and turn it into a create request, so it gets the same card, scan and name checks as one the
 * bot wrote. Only SKILL.md and its references/<topic>.md files come in; the card says what was left behind.
 */
export async function importedSkillRequest<T extends Record<string, unknown>>(body: T, fetcher: typeof fetch = fetch, cancel?: AbortSignal): Promise<T | { importError: string }> {
  if (body.action !== "import") return body;
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) return { importError: "skill_manage import needs source: owner/repo, a GitHub link to a skill folder or its SKILL.md, or a skills.sh link." };
  const fetched = await fetchSkillFromSource(source, fetcher, cancel);
  if ("error" in fetched) return { importError: `Could not import a skill from ${source}: ${fetched.error}` };
  if (fetched.skills.length !== 1) {
    const names = fetched.skills.map((skill) => skill.source.split("/").pop()).join(", ");
    return { importError: `${source} has ${fetched.skills.length} skills (${names}). Import one at a time: pass the link to that skill's folder or its skills.sh page.` };
  }
  const skill = fetched.skills[0]!;
  const skillMd = skill.files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return { importError: `${source} has no SKILL.md to import.` };
  const references = skill.files
    .filter((file) => isSkillReferencePath(file.path) && file.content.byteLength <= STAGED_SKILL_REFERENCE_MAX_BYTES)
    .slice(0, MAX_SKILL_REFERENCES);
  const left = [...skill.files.filter((file) => file !== skillMd && !references.includes(file)).map((file) => file.path), ...skill.skipped.map((file) => file.path)];
  const gist = left.length
    ? `Imported from ${skill.source}. Not brought in (only SKILL.md and references/*.md are): ${left.join(", ")}`.slice(0, STAGED_GIST_MAX)
    : body.gist;
  return {
    ...body,
    action: "create",
    skill_name: undefined,
    skill_md: skillMd.content.toString("utf8"),
    references: references.map((file) => ({ path: file.path, content: file.content.toString("utf8") })),
    source: skill.source,
    gist,
  };
}

/** Any scrub change to the SKILL.md or a reference drops sha256, so the card is deny-only and never approves bytes it did not show. */
export function scrubbedSkillRequest(request: SkillRequestCardData): SkillRequestCardData {
  const originalPreview = request.preview;
  const preview = originalPreview === undefined ? undefined : redactSecretsInText(originalPreview);
  const previewSha256 = preview !== undefined && preview === originalPreview
    ? createHash("sha256").update(preview).digest("hex")
    : undefined;
  const references = request.references?.map((file) => ({ path: redactSecretsInText(file.path), content: redactSecretsInText(file.content) }));
  const referencesUnchanged = (references ?? []).every((file, index) =>
    file.path === request.references![index]!.path && file.content === request.references![index]!.content);
  const sha256 = request.sha256 !== undefined && request.sha256 === previewSha256 && referencesUnchanged ? request.sha256 : undefined;
  return {
    ...request,
    gist: redactSecretsInText(request.gist),
    source: request.source === undefined ? undefined : redactSecretsInText(request.source),
    preview,
    sha256,
    ...(references ? { references } : {}),
    warnings: request.warnings.map((warning) => redactSecretsInText(warning)),
  };
}
