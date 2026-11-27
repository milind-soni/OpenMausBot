// `bot-tasks.json` in the data folder: the bot tasks. A file that is missing or unreadable is an empty ledger, and a task
// that does not parse is left out, so one bad record never hides the rest. Whatever is left out stays recoverable: the
// file is copied to `bot-tasks.json.bad-<time>` before the next write replaces it.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { BOT_TASK_STATUSES, type BotTask } from "../../shared/bot-tasks.ts";
import { writeFileAtomic } from "../atomic.ts";

export const BOT_TASKS_FILE = "bot-tasks.json";

const actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("person"), name: z.string() }),
  z.object({ kind: z.literal("github"), login: z.string() }),
  z.object({ kind: z.literal("system") }),
]);
const ref = z.object({ repo: z.string(), number: z.number().int().positive(), kind: z.enum(["pull", "issue"]).optional() });
const taskSchema = z.looseObject({
  id: z.string().min(1).max(80),
  title: z.string().min(1),
  status: z.enum(BOT_TASK_STATUSES),
  ownerBotId: z.string().min(1),
  createdBy: actor,
  createdAt: z.number(),
  updatedAt: z.number(),
  github: ref.optional(),
  githubState: z.object({ state: z.enum(["open", "closed", "merged"]), syncedAt: z.number(), historyBackfilled: z.literal(true).optional() }).optional(),
  activity: z.array(z.looseObject({ id: z.string(), at: z.number(), by: actor, type: z.string() })),
});
const fileSchema = z.object({ version: z.literal(1), tasks: z.array(z.unknown()) });

function keepCopy(file: string): void {
  try {
    copyFileSync(file, `${file}.bad-${Date.now()}`);
  } catch {
    // The ledger still loads; a copy that cannot be made must not stop the app.
  }
}

export function readBotTasksFile(file: string): BotTask[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      keepCopy(file);
      return [];
    }
    const tasks = parsed.data.tasks.flatMap((candidate) => {
      const task = taskSchema.safeParse(candidate);
      if (!task.success) return [];
      task.data.activity.sort((a, b) => a.at - b.at);
      return [task.data as unknown as BotTask];
    });
    if (tasks.length < parsed.data.tasks.length) keepCopy(file);
    return tasks;
  } catch {
    keepCopy(file);
    return [];
  }
}

export function writeBotTasksFile(file: string, tasks: readonly BotTask[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ version: 1, tasks }, null, 2), { mode: 0o600 });
}
