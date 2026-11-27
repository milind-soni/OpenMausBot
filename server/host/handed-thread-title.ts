import { redactSecretsInText } from "../redact.ts";
import { toolResultPrefix } from "../tool-results.ts";
import type { BotRecord, Store } from "../store.ts";

/** A persisted task keeps 80 units, so a real bot-link sender leaves room for the job itself. */
const SENDER_MAX = 18, JOB_MAX = 58;

const safeTitle = (value: string, chars: number) => {
  const clean = redactSecretsInText(value).replace(/[\p{Cc}\s]+/gu, " ").trim();
  return clean.length > chars ? `${toolResultPrefix(clean, chars - 1)}…` : clean;
};

export function standingWorkTitle(sender: string, brief: string, title?: string): string {
  const senderText = safeTitle(sender, SENDER_MAX) || "teammate";
  const label = safeTitle(title ?? brief, title === undefined ? JOB_MAX : 80 - senderText.length - 4);
  return `@${senderText} · ${label || "work"}`;
}

type TitleModel = { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> };

/** A thread a teammate opened is named from the job it was handed, as a person's first message names theirs. A work
 * thread keeps "@Sender · " in front, so the sidebar still says who the work is for. The name lands only while the
 * thread still has the title it opened with: a rename in the meantime wins. */
export function createHandedThreadTitle<Model extends TitleModel>(deps: {
  store: Pick<Store, "bot" | "taskByThread" | "retitleTask">;
  gate: (bot: BotRecord) => { ok: true; instance: Model } | { ok: false };
  generate: (model: Model, text: string) => Promise<string | null>;
}): (botId: string, threadId: string, brief: string, sender?: string) => void {
  return (botId, threadId, brief, sender) => {
    const bot = deps.store.bot(botId), machineTitle = deps.store.taskByThread(botId, threadId)?.title;
    if (!bot || !machineTitle || !brief.trim()) return;
    const gate = deps.gate(bot);
    if (!gate.ok) return;
    const safeBrief = redactSecretsInText(brief);
    void deps.generate(gate.instance, safeBrief)
      .then((title) => {
        if (!title) return;
        const next = sender === undefined ? safeTitle(title, 80) : standingWorkTitle(sender, title);
        if (next) deps.store.retitleTask(botId, threadId, machineTitle, next);
      })
      .catch(() => undefined);
  };
}
