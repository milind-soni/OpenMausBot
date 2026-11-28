import type { BotRecord, Store } from "../store.ts";
import type { AutomaticTitle, ThreadTitleGate } from "./thread-titles.ts";

export function createHandedThreadTitle(deps: {
  store: Pick<Store, "projectBotForTask" | "taskByThread" | "retitleTask">;
  gate: (bot: BotRecord) => ThreadTitleGate;
  start: (threadId: string, attempt: AutomaticTitle) => void;
}): (botId: string, threadId: string, brief: string, prefix: string) => void {
  return (botId, threadId, brief, prefix) => {
    const task = () => deps.store.taskByThread(botId, threadId);
    const machineTitle = task()?.title;
    if (!machineTitle || !brief.trim()) return;
    deps.start(threadId, {
      request: brief,
      stillCurrent: () => task()?.title === machineTitle && task()?.titleMode !== "manual",
      model: () => {
        const bot = deps.store.projectBotForTask(botId, threadId);
        return bot ? deps.gate(bot) : { ok: false, refusal: "The thread is unavailable." };
      },
      apply: (title) => { deps.store.retitleTask(botId, threadId, machineTitle, `${prefix}${title}`); },
    });
  };
}
