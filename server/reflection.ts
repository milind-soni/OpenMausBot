// Phase 4 part 3 — post-task reflection into a candidate skill.
//
// After a board task is judged complete and took real tool work, one
// model call drafts a skill in the shape the library wants: when to use,
// procedure, pitfalls, verification. The draft goes to the existing
// review card (staged, never enabled without a person — decision 8).
// Pure here: the rule, the prompt and the strict parse.

export const MIN_TOOL_STEPS = 3;
const SECTIONS = ["When to use", "Procedure", "Pitfalls", "Verification"] as const;
const NAME_MAX = 40;
const SKILL_MAX = 12_000;

export function worthReflecting(input: { judgedComplete: boolean; toolSteps: number }): boolean {
  return input.judgedComplete && input.toolSteps >= MIN_TOOL_STEPS;
}

export interface ReflectionInput {
  title: string;
  body: string;
  result: string | null;
  botSaid: string[];
  /** The tool steps the run took, as short labels. */
  activities: string[];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function reflectionPrompt(input: ReflectionInput): string {
  return [
    "You are the REFLECTOR of a skill library. You have no tools. A task was just finished and judged complete. Decide whether the way it was done is worth keeping as a reusable skill: a procedure someone would want to repeat, not a one-off answer.",
    "",
    `Task: ${input.title}`,
    `What was asked:\n${clip(input.body || "(no body)", 3_000)}`,
    `Result recorded by the harness:\n${clip(input.result ?? "(none)", 1_500)}`,
    `Tool steps taken:\n${input.activities.length ? input.activities.map((a) => `- ${clip(a, 200)}`).join("\n") : "(none)"}`,
    `What the bot said, newest last:\n${input.botSaid.length ? input.botSaid.map((s) => `- ${clip(s, 800)}`).join("\n") : "(nothing)"}`,
    "",
    "If this is not worth a skill, answer exactly: NONE",
    "Otherwise answer with one JSON object and nothing else:",
    `{"name": "short title", "description": "one line, when to use it", "skill_md": "markdown with exactly these four headings, each with content: ## ${SECTIONS.join(" / ## ")}"}`,
    "Write the procedure as numbered steps a different bot could follow, name the pitfalls this run hit or avoided, and make verification something that can be run.",
  ].join("\n");
}

export interface SkillDraft {
  name: string;
  description: string;
  /** The full SKILL.md with front matter. */
  skillMd: string;
}

export function kebab(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX).replace(/-+$/, "");
}

export function parseSkillDraft(text: string): SkillDraft | null {
  const trimmed = text.trim();
  if (!trimmed || /^NONE\b/i.test(trimmed)) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawName = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  const body = typeof parsed.skill_md === "string" ? parsed.skill_md.trim() : "";
  const name = kebab(rawName);
  if (!name || !description || !body || body.length > SKILL_MAX) return null;
  // every section present, none empty
  for (let i = 0; i < SECTIONS.length; i += 1) {
    const heading = new RegExp(`^##\\s+${SECTIONS[i]}\\s*$`, "im");
    const m = heading.exec(body);
    if (!m) return null;
    const after = body.slice(m.index + m[0].length);
    const next = /^##\s+/m.exec(after);
    const content = (next ? after.slice(0, next.index) : after).trim();
    if (!content) return null;
  }
  const withoutFrontMatter = body.replace(/^---[\s\S]*?---\s*/, "");
  const skillMd = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${withoutFrontMatter.startsWith("#") ? withoutFrontMatter : `# ${rawName}\n\n${withoutFrontMatter}`}\n`;
  return { name, description, skillMd };
}
