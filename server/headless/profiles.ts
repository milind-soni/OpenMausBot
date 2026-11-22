import { problemSentence, type ProfileApproval, type ResolvedBot } from "../../shared/profile-format.ts";
import { loadProfileFolder, ProfileFolderError } from "../profiles/load.ts";
import { EXIT, usageError } from "./args.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

const APPROVAL_LABEL: Record<ProfileApproval, string> = { ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access" };

function botLine(bot: ResolvedBot): string {
  const parts = [
    bot.name,
    ...(bot.chief ? ["Chief"] : []),
    bot.model ?? "the app's default model",
    bot.approval ? APPROVAL_LABEL[bot.approval] : "the app's default approval",
    `Edu brain ${bot.eduBrain?.mode ?? "own"}`,
    ...(bot.eduCrew ? ["Edu crew"] : []),
    ...(bot.mcpServers.length ? [`MCP ${bot.mcpServers.join(", ")}`] : []),
    ...(bot.skills.length ? [`skills ${bot.skills.map((skill) => skill.name).join(", ")}`] : []),
  ];
  return `  ${bot.id}  ${parts.join(" · ")}`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function profilesCheckVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const folder = ctx.positionals[0]?.trim();
  if (!folder) throw usageError("name the profile folder", "edubot profiles check FOLDER");
  let loaded;
  try {
    loaded = loadProfileFolder(folder);
  } catch (error) {
    if (error instanceof ProfileFolderError) throw usageError(error.message);
    throw error;
  }
  const ok = loaded.problems.length === 0;
  const result = {
    ok,
    folder: loaded.root,
    problems: loaded.problems.map((problem) => ({ ...problem, sentence: problemSentence(problem) })),
    warnings: loaded.warnings.map((warning) => ({ ...warning, sentence: problemSentence(warning) })),
    ...(loaded.org ? { organization: loaded.org } : {}),
    areas: loaded.areas,
    bots: loaded.bots,
    mcpServers: loaded.mcpServers,
    skills: loaded.skills.map(({ text: _text, ...skill }) => skill),
  };
  const human: string[] = [];
  for (const problem of loaded.problems) human.push(problemSentence(problem));
  for (const warning of loaded.warnings) human.push(`warning: ${problemSentence(warning)}`);
  const summary = [
    ...(loaded.org ? [loaded.org.name] : []),
    count(loaded.areas.length, "area"),
    count(loaded.bots.length, "bot"),
    count(loaded.skills.length, "skill"),
    count(loaded.mcpServers.length, "MCP server"),
  ].join(" · ");
  if (ok) {
    human.push(`OK: ${summary}`);
    for (const bot of loaded.bots) human.push(botLine(bot));
  } else {
    human.push(`${count(loaded.problems.length, "problem")} found. Nothing was applied: this check only reads the folder.`);
  }
  return { result, exitCode: ok ? EXIT.done : EXIT.failed, human };
}
