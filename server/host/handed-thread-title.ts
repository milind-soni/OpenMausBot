import type { BotRecord, Store } from "../store.ts";

type TitleModel = { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> };

/** A thread a teammate opened is named from the job it was handed, as a person's first message names theirs. A work
 * thread keeps "@Sender · " in front, so the sidebar still says who the work is for. The name lands only while the
 * thread still has the title it opened with: a rename in the meantime wins. */
export function createHandedThreadTitle<Model extends TitleModel>(deps: {
  store: Pick<Store, "bot" | "taskByThread" | "retitleTask">;
  gate: (bot: BotRecord) => { ok: true; instance: Model } | { ok: false };
  generate: (model: Model, text: string) => Promise<string | null>;
}): (botId: string, threadId: string, brief: string, prefix: string) => void {
  return (botId, threadId, brief, prefix) => {
    const bot = deps.store.bot(botId), machineTitle = deps.store.taskByThread(botId, threadId)?.title;
    if (!bot || !machineTitle || !brief.trim()) return;
    const gate = deps.gate(bot);
    if (!gate.ok) return;
    void deps.generate(gate.instance, brief)
      .then((title) => {
        if (title) deps.store.retitleTask(botId, threadId, machineTitle, `${prefix}${title}`);
      })
      .catch(() => undefined);
  };
}
