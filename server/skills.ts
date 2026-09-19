// Imported Agent Skills, per bot.
//
// A skill is the open agentskills.io format: a folder named after the skill
// holding SKILL.md (YAML frontmatter: name + description) and, in richer
// skills, scripts and references. This store implements a deliberately
// narrow v1 of that spec:
//
//   - SKILL.md only. Registry audits (Snyk "ToxicSkills", Feb 2026) found
//     confirmed exfiltration payloads in 2-13% of public skills. Supporting
//     files are outside the v1 review and integrity boundary, so every one is
//     skipped and named on the review surface.
//   - imports land DISABLED. The UI shows the full SKILL.md and the scan
//     warnings; a person enables it after reading. Nothing an import
//     contains reaches any prompt before that.
//   - provenance is pinned: source URL and content hash are recorded at
//     import so "where did this come from" always has an answer.
//
// Enabled skills reach the bot two ways, mirroring how MEMORY.md works:
// an index line per skill (name + description, hard budget) rides the
// system prompt, and the files themselves sit in the workspace where the
// CLI's own file tools — or its native .claude/skills discovery — read
// them on demand.
//
// Agent-authored skills (/learn + skill_manage) use the same store, but
// land in staged.json first. A person confirms the in-app card before
// applyStagedSkillWrite promotes and enables the exact bytes the person
// reviewed.

// Public import surface. The implementation lives in focused modules
// under ./skills/; every name the original single file exported is
// re-exported below, so existing "./skills.ts" imports keep working
// unchanged.

export {
  DESCRIPTION_MAX,
  INDEX_MAX_BYTES,
  INDEX_MAX_SKILLS,
  SKILL_FILE_MAX_BYTES,
  isSkillName,
  parseSkillMd,
  scanSkillText,
} from "./skills/text.ts";
export type { ParsedSkill } from "./skills/text.ts";
export { syncSkillLinks } from "./skills/manifest.ts";
export {
  listSkills,
  readSkillFile,
  removeSkill,
  setSkillEnabled,
} from "./skills/store.ts";
export type { SkillListing } from "./skills/store.ts";
export {
  MAX_STAGED_SKILLS,
  STAGED_GIST_MAX,
  STAGED_SKILL_FILE_MAX_BYTES,
  applySkillWriteWithReceipt,
  applyStagedSkillWrite,
  getStagedSkillWrite,
  installSkill,
  listStagedSkillWrites,
  rejectStagedSkillWrite,
  stageSkillWrite,
} from "./skills/staged.ts";
export type { StagedSkillAction, StagedSkillWrite } from "./skills/staged.ts";
export { skillsSystemPrompt } from "./skills/prompt.ts";
