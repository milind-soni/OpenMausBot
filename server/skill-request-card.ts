import { createHash } from "node:crypto";

import { redactSecretsInText } from "./redact.ts";
import { listSkills, readSkillFile, readSkillReferences } from "./skills.ts";
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
