// The bot task tools (docs/bot-tasks.md), mounted only while Settings → Bot tasks is on. Each is a thin call to its
// internal route (server/routes/bot-task-tools.ts), which checks the bot, the evidence rule and the settings.
import { BOT_TASK_STATUSES } from "../../shared/bot-tasks.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const BOT_TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["task_create", "task_update", "task_comment", "task_link_github", "task_list", "task_get"]);

const PATHS: Record<string, string> = {
  task_create: "create", task_update: "update", task_comment: "comment", task_link_github: "link", task_list: "list", task_get: "get",
};

export async function callBotTaskTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(`/api/internal/bot-tasks/${PATHS[name]}`, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The task list did not answer. Try again shortly."), isError: true };
}

const EVIDENCE = {
  type: "array",
  maxItems: 10,
  description: "What backs the claim. One is enough: a verified commit, a successful GitHub Actions run or job, a verified review or comment link, or a recorded command with exit code 0.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["commit", "ci_run", "review_url", "command"] },
      sha: { type: "string", description: "commit: the hash (7 to 40 hex)." },
      repo: { type: "string", description: "commit: owner/repo it is in." },
      url: { type: "string", description: "ci_run: the GitHub Actions run or job URL. review_url: the anchored review or comment URL on the linked GitHub item." },
      command: { type: "string", maxLength: 500, description: "command: what you ran." },
      exitCode: { type: "integer", description: "command: its exit code. Only 0 counts as proof of done." },
    },
    required: ["kind"],
  },
};

export const BOT_TASK_TOOL_DEFINITIONS = [
  {
    name: "task_create",
    description: "Open a task in the shared task list for work you start or take on. You own it. A GitHub pull request or issue (owner/repo#n or its URL) in github or text is linked.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 160 },
        text: { type: "string", maxLength: 4000, description: "First note: what it is and what done means." },
        github: { type: "string", description: "owner/repo#number or the pull request or issue URL." },
        owner: { type: "string", description: "Hand it to this bot (name or id); default: you." },
      },
      required: ["title"],
    },
  },
  {
    name: "task_update",
    description: "Move a task to open, in_progress, blocked, review, done or cancelled. done needs evidence (and review too when Settings says so): the server refuses without it. Report evidence, not prose.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Task id from task_list." },
        status: { type: "string", enum: [...BOT_TASK_STATUSES] },
        evidence: EVIDENCE,
        comment: { type: "string", maxLength: 4000, description: "A line for the log with the move." },
        owner: { type: "string", description: "Hand the task to this bot instead (name or id)." },
      },
      required: ["id"],
    },
  },
  {
    name: "task_comment",
    description: "Add a note to a task's log: progress, a finding, a question for the next bot. It stays in this app; it is never posted to GitHub.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, text: { type: "string", maxLength: 4000 } },
      required: ["id", "text"],
    },
  },
  {
    name: "task_link_github",
    description: "Link a task to the GitHub pull request or issue it is about, so the app can follow its comments, reviews, checks and merge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, ref: { type: "string", description: "owner/repo#number or the pull request or issue URL." } },
      required: ["id", "ref"],
    },
  },
  {
    name: "task_list",
    description: "The tasks of the shared list, newest first, one line each. Filter by status, owner bot, repo or words.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: [...BOT_TASK_STATUSES] },
        mine: { type: "boolean", description: "Only tasks you own." },
        repo: { type: "string", description: "owner/repo" },
        query: { type: "string", maxLength: 200 },
      },
    },
  },
  {
    name: "task_get",
    description: "One task with its log: notes, status changes with their evidence, and what came in from GitHub. Pass sync to fetch GitHub's news first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, sync: { type: "boolean", description: "Poll the linked pull request or issue now." } },
      required: ["id"],
    },
  },
];
