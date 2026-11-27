// The bot task tools (task_create, task_update, task_comment, task_link_github, task_list, task_get),
// inside index.ts's /api/internal/ block after the capability bearer is checked: the bot and its thread are the
// capability's, never a body field. Answer 404 while Settings → Bot tasks is off.
//   POST /api/internal/bot-tasks/{create,update,comment,link,list,get,post}
// Security: the evidence rule and the Settings switches are enforced by the service (server/bot-tasks/service.ts), not
// here.
import { z } from "zod";

import { BOT_TASK_LIMITS, BOT_TASK_STATUSES, type BotTask, type BotTaskActivity, type BotTaskActor, type BotTaskGithubRef, type BotTasksSettings, type BotTaskSummary } from "../../shared/bot-tasks.ts";
import { BotTaskError, EVIDENCE_EXAMPLE, refLabel } from "../bot-tasks/evidence.ts";
import type { BotTasks } from "../bot-tasks/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const BOT_TASK_TOOL_PATH = "/api/internal/bot-tasks";

export interface BotTaskToolDeps {
  tasks: Pick<BotTasks, "create" | "comment" | "setStatus" | "setOwner" | "linkGithub" | "list" | "get" | "sync">;
  settings(): BotTasksSettings;
  requireActive(): void;
  botId(): string;
  readBody(): Promise<unknown>;
  botName(botId: string): string | undefined;
  /** Every bot a task can be handed to. */
  bots(): ReadonlyArray<{ id: string; name: string }>;
}

const text = (max: number) => z.string().max(max);
const createSchema = z.object({ title: text(400), text: text(BOT_TASK_LIMITS.textMax).optional(), github: text(300).optional(), owner: text(200).optional() }).strict();
const updateSchema = z.object({
  id: text(100), status: z.enum(BOT_TASK_STATUSES).optional(), evidence: z.array(z.unknown()).max(BOT_TASK_LIMITS.evidencePerMove).optional(),
  comment: text(BOT_TASK_LIMITS.textMax).optional(), owner: text(200).optional(),
}).strict();
const commentSchema = z.object({ id: text(100), text: text(BOT_TASK_LIMITS.textMax) }).strict();
const linkSchema = z.object({ id: text(100), ref: text(300) }).strict();
const listSchema = z.object({ status: z.enum(BOT_TASK_STATUSES).optional(), mine: z.boolean().optional(), repo: text(200).optional(), query: text(200).optional() }).strict();
const getSchema = z.object({ id: text(100), sync: z.boolean().optional() }).strict();

const USAGE: Record<string, string> = {
  create: 'task_create takes title, text?, github? and owner?. Example: {"title":"Fix the scan crash","github":"owner/repo#12"}',
  update: `task_update takes id and status and/or owner, plus evidence? and comment?. ${EVIDENCE_EXAMPLE}`,
  comment: 'task_comment takes id and text. Example: {"id":"t_1","text":"Reproduced; the cause is in the parser."}',
  link: 'task_link_github takes id and ref. Example: {"id":"t_1","ref":"owner/repo#12"}',
  list: "task_list takes status?, mine?, repo? and query?.",
  get: "task_get takes id and sync?.",
};

const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

const actorName = (by: BotTaskActor) => by.kind === "bot" ? by.name : by.kind === "person" ? by.name : by.kind === "github" ? `${by.login} (GitHub)` : "app";

function activityLine(entry: BotTaskActivity, now: number): string {
  const head = `${ago(entry.at, now)} ${actorName(entry.by)}`;
  switch (entry.type) {
    case "created": return `${head}: created the task`;
    case "comment": return `${head}: ${oneLine(entry.text, 400)}`;
    case "status": {
      const proof = entry.evidence?.map((item) => {
        const claim = item.kind === "commit" ? `commit ${item.sha.slice(0, 12)}`
          : item.kind === "command" ? `\`${oneLine(item.command, 80)}\` exit ${item.exitCode}` : item.url;
        return item.verification ? `${claim} [${item.verification.status}]` : claim;
      }).join("; ");
      return `${head}: ${entry.from} → ${entry.to}${proof ? ` (evidence: ${proof})` : ""}`;
    }
    case "owner": return `${head}: handed over to ${entry.to}`;
    case "github_ref": return `${head}: linked ${refLabel(entry.ref)}`;
    case "github_comment": return `${head} commented on GitHub: ${oneLine(entry.text, 400)}${entry.url ? ` ${entry.url}` : ""}`;
    case "github_review": return `${head} reviewed on GitHub (${entry.state}): ${oneLine(entry.text, 400)}${entry.url ? ` ${entry.url}` : ""}`;
    case "github_check": return `${head}: check ${entry.name} ${entry.conclusion}${entry.url ? ` ${entry.url}` : ""}`;
    case "github_state": return `${head}: GitHub ${entry.state}${entry.url ? ` ${entry.url}` : ""}`;
    case "posted": return `${head}: posted to GitHub${entry.merged ? " and merged" : ""} ${entry.url}`;
    case "sync_error": return `${head}: sync problem: ${entry.text}`;
  }
}

const refText = (ref: BotTaskGithubRef | undefined) => (ref ? ` · ${refLabel(ref)}` : "");

function summaryLine(task: BotTaskSummary): string {
  return `- ${task.id} [${task.status}] ${oneLine(task.title, 120)} · ${task.ownerName}${refText(task.github)}`;
}

function taskHead(task: BotTask, ownerName: string): string {
  const state = task.githubState ? ` (GitHub: ${task.githubState.state})` : "";
  return `${task.id} [${task.status}] ${task.title}\nowner ${ownerName}${task.github ? ` · ${refLabel(task.github)}${state}` : ""}`;
}

export function createBotTaskToolRoutes(deps: BotTaskToolDeps): RouteHandler {
  const botActor = (botId: string): BotTaskActor => ({ kind: "bot", id: botId, name: deps.botName(botId) ?? "Bot" });

  function resolveBot(raw: string): string {
    const wanted = raw.trim().replace(/^@/, "").toLowerCase();
    const hits = deps.bots().filter((bot) => bot.id === raw.trim() || bot.name.toLowerCase() === wanted);
    if (hits.length === 1) return hits[0]!.id;
    throw new BotTaskError(400, hits.length ? `More than one bot is called "${raw}": use its id (${hits.map((bot) => bot.id).join(", ")}).` : `No bot is called "${raw}".`);
  }

  function suggestion(suggested: readonly BotTaskGithubRef[], linked: boolean): string {
    return !linked && suggested.length ? ` It mentions ${suggested.map(refLabel).join(", ")}: link one with task_link_github if it belongs to this task.` : "";
  }

  async function run(action: string, raw: unknown, botId: string): Promise<{ status: number; text: string }> {
    const by = botActor(botId);
    const now = Date.now();
    switch (action) {
      case "create": {
        const body = createSchema.parse(raw);
        const owner = body.owner?.trim() ? resolveBot(body.owner) : botId;
        const { task, suggested } = deps.tasks.create({ title: body.title, ownerBotId: owner, by, ...(body.github ? { github: body.github } : {}), ...(body.text ? { text: body.text } : {}) });
        return { status: 201, text: `Opened ${task.id}${task.github ? `, linked to ${refLabel(task.github)}` : ""}.${suggestion(suggested, Boolean(task.github))} Move it with task_update; done needs evidence.` };
      }
      case "update": {
        const body = updateSchema.parse(raw);
        if (body.status === undefined && body.owner === undefined) throw new BotTaskError(400, USAGE.update!);
        const ownerBotId = body.owner?.trim() ? resolveBot(body.owner) : undefined;
        if (body.status === undefined && ownerBotId === undefined) throw new BotTaskError(400, USAGE.update!);
        const task = body.status
          ? await deps.tasks.setStatus(body.id, { status: body.status, evidence: body.evidence, comment: body.comment, ownerBotId, by })
          : deps.tasks.setOwner(body.id, ownerBotId!, by);
        return { status: 200, text: `${task.id} is now ${task.status}, owned by ${deps.botName(task.ownerBotId) ?? task.ownerBotId}.` };
      }
      case "comment": {
        const body = commentSchema.parse(raw);
        const { task, suggested } = deps.tasks.comment(body.id, body.text, by);
        return { status: 200, text: `Noted on ${task.id}. It stays in this app.${suggestion(suggested, Boolean(task.github))}` };
      }
      case "link": {
        const body = linkSchema.parse(raw);
        const task = deps.tasks.linkGithub(body.id, body.ref, by);
        return { status: 200, text: `${task.id} is linked to ${refLabel(task.github!)}.${deps.settings().githubSync ? " The app backfills its history and follows new GitHub activity." : " GitHub sync is off in Settings, so nothing is imported until it is turned on."}` };
      }
      case "list": {
        const body = listSchema.parse(raw ?? {});
        const rows = deps.tasks.list({ ...(body.status ? { status: body.status } : {}), ...(body.mine ? { botId } : {}), ...(body.repo ? { repo: body.repo } : {}), ...(body.query ? { query: body.query } : {}), limit: BOT_TASK_LIMITS.listMax });
        return { status: 200, text: rows.length ? rows.map(summaryLine).join("\n") : "No tasks." };
      }
      case "get": {
        const body = getSchema.parse(raw);
        let note = "";
        if (body.sync) {
          try {
            const result = await deps.tasks.sync(body.id);
            note = result.added ? `GitHub: ${result.added} new entr${result.added === 1 ? "y" : "ies"}.\n` : "GitHub: nothing new.\n";
          } catch (error) {
            if (!(error instanceof BotTaskError)) throw error;
            note = `GitHub sync did not run: ${error.message}\n`;
          }
        }
        const task = deps.tasks.get(body.id);
        const log = task.activity.slice(-40).map((entry) => `  ${activityLine(entry, now)}`);
        const hidden = task.activity.length - log.length;
        return { status: 200, text: `${note}${taskHead(task, task.ownerName)}\nLog${hidden > 0 ? ` (last ${log.length} of ${task.activity.length})` : ""}:\n${log.join("\n")}` };
      }
      default:
        throw new BotTaskError(404, "not found");
    }
  }

  return async ({ res, path, method, json }) => {
    if (path !== BOT_TASK_TOOL_PATH && !path.startsWith(`${BOT_TASK_TOOL_PATH}/`)) return PASS;
    if (!deps.settings().enabled) return json(res, 404, { error: "Bot tasks are off here. The person turns them on in Settings → Bot tasks." });
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    deps.requireActive();
    const action = path.slice(BOT_TASK_TOOL_PATH.length + 1);
    const raw = await deps.readBody();
    try {
      const answer = await run(action, raw, deps.botId());
      return json(res, answer.status, { text: answer.text });
    } catch (error) {
      if (error instanceof BotTaskError) return json(res, error.status, { error: error.message });
      if (error instanceof z.ZodError) return json(res, 400, { error: USAGE[action] ?? "Invalid request." });
      throw error;
    }
  };
}
