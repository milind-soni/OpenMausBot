// The Skills page's wire shapes: every skill a bot can use, from any source, as one list.

/** Every bot (now and later), the chosen bots, or none. */
export type SkillWho = "all" | "bots" | "off";

/** Where a skill came from, as the page names it. */
export type SkillFrom =
  | { kind: "builtin" }
  | { kind: "github"; where: string }
  | { kind: "link"; where: string }
  | { kind: "written" }
  | { kind: "learned"; botId?: string }
  | { kind: "team" }
  | { kind: "tool"; tool: "claudeCode" | "codex" }
  | { kind: "project" };

/** Why a skill is off until a person looks: what the safety scan found, or files that changed after it was added. */
export type SkillFlag = "blob" | "pipe" | "invisible" | "changed" | "other";

export interface SkillWire {
  /** Stable across reloads: the source's kind, then the skill's name. */
  id: string;
  name: string;
  description: string;
  from: SkillFrom;
  who: SkillWho;
  /** The bots that use it now. */
  bots: string[];
  /** Only these bots can have it; absent: any bot. */
  only?: string[];
  flag?: SkillFlag;
  removable: boolean;
}

export interface SkillDetailWire {
  /** The instructions, without the name and description header. */
  instructions: string;
  /** Every other file, by its path inside the skill. */
  files: string[];
}

export interface SkillAccessWire {
  who: SkillWho;
  bots?: string[];
}

/** POST /api/skills: a link to a skill on GitHub, or one written here. */
export type AddSkillWire =
  | { link: string }
  | { name: string; description: string; instructions: string };

const SCAN_FLAGS: Array<[RegExp, SkillFlag]> = [[/base64/, "blob"], [/curl\|sh|into a shell/, "pipe"], [/invisible/, "invisible"], [/changed/, "changed"]];

/** The first scan warning, as the flag the page explains in one line. */
export function skillFlag(warnings: readonly string[]): SkillFlag | undefined {
  const first = warnings[0];
  if (first === undefined) return undefined;
  return SCAN_FLAGS.find(([pattern]) => pattern.test(first))?.[1] ?? "other";
}

/** "weekly-report" reads as "Weekly report". */
export function skillTitle(skill: Pick<SkillWire, "name">): string {
  const words = skill.name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a stored `source` says a skill came from. */
export function skillFrom(source: string, learnedBy?: string): SkillFrom {
  if (source.startsWith("learn:")) return learnedBy ? { kind: "learned", botId: learnedBy } : { kind: "learned" };
  if (source.startsWith("org:")) return { kind: "team" };
  if (source.startsWith("written:") || source === "local-import") return { kind: "written" };
  const github = /^(?:https?:\/\/)?(?:github\.com|raw\.githubusercontent\.com)\/([^/@\s]+)\/([^/@\s]+)/i.exec(source);
  if (github) return { kind: "github", where: `${github[1]}/${github[2]}` };
  return { kind: "link", where: source };
}
