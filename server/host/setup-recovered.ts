// A setup failure (an engine signed out or out of credits) marks its conversation "dead", and one dead conversation makes
// the whole bot read "unavailable — needs setup" to its teammates (peer-roster.ts), in the app and in reports, until that
// same conversation runs again. A later turn of the bot that succeeds on the same engine shows that engine's setup works
// now, so the label goes with it. A conversation whose engine is another keeps it: that engine may still be signed out.
import type { Store } from "../store.ts";

/** server/index.ts parks this in lastInstanceId when a conversation was carried in from elsewhere: no engine. */
const EXTERNAL_CONTEXT = "__openmaus_external_context__:";

type Task = { lastInstanceId?: string; modelSelection?: { instanceId: string } };

export function clearSetupFailures(store: Pick<Store, "bot" | "setTaskActivity">, botId: string, threadId: string): void {
  const bot = store.bot(botId);
  const succeeded = bot?.tasks?.find((task) => task.threadId === threadId);
  if (!bot || !succeeded) return;
  // The engine a turn was last sent to (a stand-in after a failover included), else the one the conversation is set to.
  const engineOf = (task: Task) => task.lastInstanceId && !task.lastInstanceId.startsWith(EXTERNAL_CONTEXT)
    ? task.lastInstanceId : (task.modelSelection ?? bot.modelSelection).instanceId;
  const engine = engineOf(succeeded);
  for (const task of bot.tasks ?? []) {
    if (task.activity === "dead" && engineOf(task) === engine) store.setTaskActivity(botId, task.threadId, "idle");
  }
}
