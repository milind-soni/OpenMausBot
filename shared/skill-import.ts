// What a skill brought in from outside carries with it: where it came from, and what came with SKILL.md.

/** The GitHub folder a skill was imported from, at the commit its files were read at. */
export interface GitHubSkillOrigin {
  owner: string;
  repo: string;
  /** The branch, tag or commit the link named; "HEAD" when it named none, which follows the default branch. */
  ref: string;
  /** The 40-hex commit every imported file was read at. */
  commit: string;
  /** The skill's folder inside the repository; "" for the repository root. */
  path: string;
}

/** Why one entry of a skill's folder did not come in. */
export type SkippedSkillFileReason =
  /** A symbolic link. */
  | "link"
  /** Another repository nested inside (a git submodule). */
  | "submodule"
  /** A dot file or dot folder. */
  | "hidden"
  /** A cache a run leaves behind, such as __pycache__ or node_modules. */
  | "generated"
  /** A name some disks cannot hold. */
  | "name"
  /** Differs only in letter case from another entry. */
  | "duplicate"
  /** Deeper than the folder depth limit. */
  | "deep"
  /** Over the size limit for one file. */
  | "large"
  /** Past the folder's file-count or size limit. */
  | "full"
  /** A Git LFS pointer, whose real file GitHub keeps elsewhere. */
  | "lfs"
  /** GitHub would not list the folder, so only SKILL.md came in. */
  | "unlisted";

export interface SkippedSkillFile {
  /** Inside the skill's folder; a folder ends in "/" and stands for everything below it. */
  path: string;
  reason: SkippedSkillFileReason;
}

/** One imported skill, as the import reports it. */
export interface SkillImportSummary {
  name: string;
  /** Every file that came in, SKILL.md included. */
  files: number;
  /** How many of those are scripts. */
  scripts: number;
  /** The first few entries left out; `skippedCount` counts them all. */
  skipped: SkippedSkillFile[];
  skippedCount: number;
}
