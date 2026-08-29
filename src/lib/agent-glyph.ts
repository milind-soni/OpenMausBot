export const AGENT_GLYPH_KINDS = [
  "coordinate",
  "operate",
  "capture",
  "build",
  "research",
  "computer",
  "general",
] as const;

export type AgentGlyphKind = (typeof AGENT_GLYPH_KINDS)[number];

export type AgentGlyphIdentity = {
  name?: string;
  title?: string;
  description?: string;
  chiefOfStaff?: boolean;
};

const ROLE_PATTERNS: ReadonlyArray<{ kind: Exclude<AgentGlyphKind, "coordinate" | "general">; pattern: RegExp }> = [
  { kind: "operate", pattern: /\b(?:ops|operations?|reliability|monitor|watch|watchdog|sre)\b/i },
  { kind: "capture", pattern: /\b(?:capture|collector|ingest|inbox|memory|source|sync)\b/i },
  { kind: "build", pattern: /\b(?:build|builder|code|coding|developer|engineer|product)\b/i },
  { kind: "research", pattern: /\b(?:research|analyst|analysis|investigate|intelligence)\b/i },
  { kind: "computer", pattern: /\b(?:browser|computer|desktop|windows|automation|operator)\b/i },
];

/**
 * Pick a compact visual role from user-editable identity metadata. This is a
 * presentation hint only; authorization remains capability-based.
 */
export function agentGlyphKind(identity: AgentGlyphIdentity): AgentGlyphKind {
  if (identity.chiefOfStaff) return "coordinate";
  const searchable = [identity.name, identity.title, identity.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return ROLE_PATTERNS.find(({ pattern }) => pattern.test(searchable))?.kind ?? "general";
}
