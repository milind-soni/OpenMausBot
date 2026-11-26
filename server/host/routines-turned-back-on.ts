// Routines an earlier version switched off after their cloud desktop failed to start come back on once
// (routine-no-start.ts). Each bot that has one gets a single quiet line in its own chat saying which: no card, nothing
// to answer, no notification.
import type { Routine } from "../routines.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { Store } from "../store.ts";

export function tellTurnedBackOn(store: Pick<Store, "bot" | "appendMessage">, routines: readonly Pick<Routine, "botId" | "name">[]): void {
  const byBot = new Map<string, string[]>();
  for (const routine of routines) byBot.set(routine.botId, [...(byBot.get(routine.botId) ?? []), routine.name]);
  for (const [botId, names] of byBot) {
    const bot = store.bot(botId);
    if (!bot) continue;
    const line = serverLine(conversationLanguage(bot.threadId), names.length === 1 ? "server.routines.turnedBackOn" : "server.routines.turnedBackOnMany", { names: names.join(", ") });
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${line}`, ok: true } });
  }
}
