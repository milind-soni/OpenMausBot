// A setup failure (an engine signed out or out of credits) marks its conversation "dead", and one dead conversation makes
// the whole bot read "unavailable — needs setup" to its teammates (peer-roster.ts), in the app and in reports, until that
// same conversation runs again. A later turn of the bot on the same engine that succeeds shows that engine's setup works
// now, so the label goes with it. A conversation on another engine keeps it: its engine may still be signed out.
import type { Store } from "../store.ts";

export function clearSetupFailures(store: Pick<Store, "bot" | "setTaskActivity">, botId: string, threadId: string): void {
  const bot = store.bot(botId);
  if (!bot) return;
  const engineOf = (task: { modelSelection?: { instanceId: string } }) => (task.modelSelection ?? bot.modelSelection).instanceId;
  const succeeded = bot.tasks?.find((task) => task.threadId === threadId);
  if (!succeeded) return;
  for (const task of bot.tasks ?? []) {
    if (task.activity === "dead" && engineOf(task) === engineOf(succeeded)) store.setTaskActivity(botId, task.threadId, "idle");
  }
}
