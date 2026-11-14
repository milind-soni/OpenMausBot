// "Bring what you already use": the skills and MCP servers of a person's other AI tools that the welcome flow finds
// on this computer and brings in.

export type SetupSource = "claudeCode" | "claudeDesktop" | "cursor" | "codex" | "gemini";
export type SkillSource = Extract<SetupSource, "claudeCode" | "codex">;

/** Names only, never a file's contents or an env or header value. Everything listed is new here. */
export interface SetupDetection {
  skills: Array<{ name: string; source: SkillSource }>;
  tools: Array<{ name: string; source: SetupSource }>;
}

export interface SetupImportRequest {
  skills?: boolean;
  tools?: boolean;
}

export type SkillSkip = "conflict" | "failed";
/** "conflict": a different server already has that name here; "failed": it could not be saved. */
export type ToolSkip = "limit" | "policy" | "busy" | "conflict" | "failed";

/** Names and counts only. `review`: skills added switched off, because the scan flagged them, until a person reads them. */
export interface SetupImportResult {
  skills?: { added: string[]; present: string[]; skipped: Array<{ name: string; reason: SkillSkip }>; filesLeftOut: number; review: string[] };
  tools?: { added: string[]; present: string[]; skipped: Array<{ name: string; reason: ToolSkip }> };
}

export function detectionCount(detection: SetupDetection | null | undefined): number {
  return detection ? detection.skills.length + detection.tools.length : 0;
}

/** Each source once, in the order first found. */
export function detectionSources<Source extends SetupSource>(items: ReadonlyArray<{ source: Source }>): Source[] {
  return [...new Set(items.map((item) => item.source))];
}
