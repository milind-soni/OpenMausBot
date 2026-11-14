// A command the person writes: a name, one line on what it does, and the
// instructions. Stored as an ordinary SKILL.md through the per-bot install, so
// it needs no store of its own and runs as `/name` from the composer.
import { DESCRIPTION_MAX, isSkillName, parseSkillMd, yamlFrontmatterValue } from "./skill-md.ts";

export const WRITTEN_SKILL_SOURCE = "written:bot settings";
export const WRITTEN_INSTRUCTIONS_MAX = 16_000;
/** Names the composer keeps for its own commands. */
const RESERVED = ["goal", "learn", "setup"];

export interface WrittenSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export type WrittenSkillProblem = "name" | "reserved" | "taken" | "description" | "instructions";

/** One line, no frontmatter-breaking characters. */
export function writtenSkillDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^["']+|["']+$/g, "").trim();
}

/** What is wrong with the draft, first problem only, or null. `taken` is
 * the bot's current skill names, library ones included, since a private
 * skill with the same name would quietly shadow a library skill. */
export function writtenSkillProblem(input: WrittenSkillInput, taken: readonly string[] = []): WrittenSkillProblem | null {
  const name = input.name.trim();
  if (!isSkillName(name)) return "name";
  if (RESERVED.includes(name)) return "reserved";
  if (taken.includes(name)) return "taken";
  const description = writtenSkillDescription(input.description);
  if (!description || description.length > DESCRIPTION_MAX) return "description";
  const instructions = input.instructions.trim();
  if (!instructions || instructions.length > WRITTEN_INSTRUCTIONS_MAX) return "instructions";
  return null;
}

/** The SKILL.md for a written command. Throws on a draft that
 * `writtenSkillProblem` rejects, so a caller cannot store a broken file. */
export function writtenSkillMd(input: WrittenSkillInput): string {
  const problem = writtenSkillProblem(input);
  if (problem) throw new Error(`written skill: invalid ${problem}`);
  const name = input.name.trim();
  const description = writtenSkillDescription(input.description);
  const text = `---\nname: ${name}\ndescription: ${yamlFrontmatterValue(description)}\n---\n\n` +
    `# /${name}\n\n` +
    `A command the user wrote. When they run /${name}, follow these instructions. ` +
    "Where they say {input}, use what the user typed after the command.\n\n" +
    `${input.instructions.trim()}\n`;
  const parsed = parseSkillMd(text);
  if ("error" in parsed || parsed.name !== name || parsed.description !== description) {
    throw new Error("written skill: did not round-trip");
  }
  return text;
}
