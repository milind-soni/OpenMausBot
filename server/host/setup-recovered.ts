// A setup failure (an engine signed out or out of credits) marks its conversation "dead", and one dead conversation makes
// the whole bot read "unavailable — needs setup" to its teammates (peer-roster.ts), in the app and in reports, until that
// same conversation runs again. A later turn of the bot that succeeds shows its setup works now, so the label goes with it.
import type { Store } from "../store.ts";

export function clearSetupFailures(store: Pick<Store, "bot" | "setTaskActivity">, botId: string): void {
  for (const task of store.bot(botId)?.tasks ?? []) {
    if (task.activity === "dead") store.setTaskActivity(botId, task.threadId, "idle");
  }
}
