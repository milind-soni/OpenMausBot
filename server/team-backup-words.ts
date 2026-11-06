import { goalHistoryWords, type BackupTask } from "../shared/team-backup.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import type { Message } from "./store.ts";
import { chatNotice } from "./chat-notices.ts";

type GoalWords = Pick<BackupTask["messages"][number], "text" | "textCode" | "textParams">;

function goalLine(textCode: NonNullable<GoalWords["textCode"]>, before: string, content: string): GoalWords {
  const textParams = { before: redactSecretsInText(before), content: redactSecretsInText(content) };
  return { text: chatNotice(textCode, textParams), textCode, textParams };
}

export function exportedGoalWords(message: Pick<Message, "goalRun" | "role">, text: string, before = "", after?: string): GoalWords {
  const run = message.goalRun;
  if (!run || message.role !== "bot") return { text };
  const words = [run.goal, run.detail].filter(Boolean).join("\n");
  const content = after ?? (words ? `\n${words}` : "");
  const code = `chat.notice.exportedGoal.${run.status}` as const;
  if (chatNotice(code, { before, content }) !== text) return { text };
  return goalLine(code, before, content);
}

export function restoredGoalWords(message: unknown): Partial<GoalWords> {
  const parsed = goalHistoryWords.safeParse(message);
  if (!parsed.success) return {};
  const { text, textCode, textParams } = parsed.data;
  if (chatNotice(textCode, textParams) !== text) return {};
  return goalLine(textCode, textParams.before, textParams.content);
}
