import { resolve } from "node:path";

import { problemSentence, type ProfileApproval, type ResolvedBot } from "../../shared/profile-format.ts";
import type { ProfileApplyResult, ProfileChoice, ProfilePlan, ProfilePlanLine, ProfilePlanLineKind } from "../../shared/profile-plan.ts";
import { loadProfileFolder, ProfileFolderError } from "../profiles/load.ts";
import { EXIT, usageError, type Flags } from "./args.ts";
import { explain } from "./client.ts";
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

const HEADINGS: Array<[ProfilePlanLineKind, string]> = [
  ["add", "Adds"], ["change", "Changes"], ["access", "Gives more access"], ["remove", "Deletes"],
  ["conflict", "Conflicts: choose with --keep-mine KEY or --take-file KEY"], ["changed-here", "Changed here, kept"], ["gone", "No longer in your profiles, kept"],
  ["blocked", "Left as they are until their files are fixed"], ["later", "Comes in a later update"], ["note", "Notes"],
];

function planText(plan: ProfilePlan): string[] {
  const human: string[] = [...plan.problems.map((problem) => problem.sentence), ...plan.warnings.map((warning) => `warning: ${warning.sentence}`)];
  for (const [kind, heading] of HEADINGS) {
    const lines = plan.lines.filter((line) => line.kind === kind);
    if (!lines.length) continue;
    human.push(`${heading}:`);
    for (const line of lines) human.push(`  ${line.conflict ? `${line.conflict.choice}  ` : ""}${line.text}`);
  }
  const { add, change, access, conflict, remove } = plan.counts;
  human.push(plan.noChanges ? "No changes." : `Plan: ${add} to add, ${change} to change, ${access} giving more access, ${remove} to delete, ${conflict} to decide.`);
  return human;
}

function choicesFrom(flags: Flags): Record<string, ProfileChoice> {
  const choices: Record<string, ProfileChoice> = {};
  for (const [flag, choice] of [["keep-mine", "mine"], ["take-file", "file"]] as const) {
    for (const key of (flags[flag] as string[] | undefined) ?? []) {
      if (choices[key] && choices[key] !== choice) throw usageError(`${key} is given both --keep-mine and --take-file`);
      choices[key] = choice;
    }
  }
  return choices;
}

function profileRequest(ctx: VerbContext): { folder: string; choices: Record<string, ProfileChoice>; prune: boolean } {
  const folder = ctx.positionals[0]?.trim();
  if (!folder) throw usageError("name the profile folder", `edubot ${ctx.verb} FOLDER`);
  return { folder: resolve(folder), choices: choicesFrom(ctx.flags), prune: ctx.flags.prune === true };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** The server reads the folder, so it must be on the server's computer. */
export async function profilesPlanVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const request = profileRequest(ctx);
  const client = await ctx.client();
  const plan = await client.json<ProfilePlan>("/api/profiles/plan", post(request));
  return { result: { ok: true, ...plan }, exitCode: EXIT.done, human: planText(plan) };
}

export async function profilesApplyVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const request = profileRequest(ctx);
  const client = await ctx.client();
  const plan = await client.json<ProfilePlan>("/api/profiles/plan", post(request));
  const human = planText(plan);
  if (plan.noChanges) return { result: { ok: true, ...plan, applied: { lines: [], skipped: [] } }, exitCode: EXIT.done, human };
  const access = plan.lines.filter((line) => line.kind === "access");
  const giveAccess = access.length > 0 && ctx.flags["without-access"] !== true;
  let result: ProfileApplyResult;
  try {
    result = await client.json<ProfileApplyResult>("/api/profiles/apply", post({ ...request, giveAccess, expect: plan.digest }));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403 && giveAccess) {
      const refusal = `Nothing was applied: ${access.length} change${access.length === 1 ? " gives" : "s give"} a bot more access, which only the desktop app or a paired admin device may confirm. Run \`edubot login\` from a paired device and apply again, or apply the rest with --without-access.`;
      return { result: { ok: false, error: refusal, ...plan }, exitCode: EXIT.notAllowed, human: [...human, refusal] };
    }
    throw await explain(error, client.baseUrl);
  }
  const skipped = (line: ProfilePlanLine & { reason: string }) => `  ${line.text}: ${line.reason}`;
  const open = plan.lines.filter((line) => line.kind === "conflict");
  const refused = result.applied.skipped.filter((line) => line.kind !== "access" || giveAccess);
  human.push(`Applied ${result.applied.lines.length} change${result.applied.lines.length === 1 ? "" : "s"}.`);
  if (result.applied.skipped.length) human.push("Not applied:", ...result.applied.skipped.map(skipped));
  if (open.length) human.push(`${open.length} conflict${open.length === 1 ? " is" : "s are"} left as they are until you choose.`);
  return {
    result: { ok: !refused.length && !open.length, ...result },
    exitCode: refused.length ? EXIT.failed : open.length ? EXIT.conflict : EXIT.done,
    human,
  };
}
