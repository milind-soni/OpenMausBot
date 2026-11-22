import { createHash } from "node:crypto";
import { DEFAULT_REBUILD_BYTES, replayToolCalls, selectReplay } from "../context-rebuild.ts";
import type { ContextMessage } from "../delta-context.ts";
import type { BotRecord, Message } from "../store.ts";

type Compaction = NonNullable<Parameters<typeof selectReplay>[1]>["compaction"];

export interface ResumeCheckDeps {
  directContext(bot: BotRecord, threadId: string, messages: Message[]): ContextMessage[];
  latestCompaction(messages: readonly Message[]): Compaction;
  context(): { rebuildBytes?: number; replayToolHistory?: boolean } | undefined;
  everyBotRules(): string | undefined;
  sectionPrompt(section: string | undefined): string;
}

export function createResumeCheck(deps: ResumeCheckDeps) {
  const replayInputs = (bot: BotRecord, threadId: string, activeMessages: Message[], skip: ReadonlySet<string>) => {
    const context = deps.directContext(bot, threadId, activeMessages);
    const record = deps.latestCompaction(activeMessages);
    const settings = deps.context();
    const selection = selectReplay(context, { budgetBytes: settings?.rebuildBytes ?? DEFAULT_REBUILD_BYTES, excludedIds: skip, compaction: record, tools: replayToolCalls(activeMessages, settings) });
    return { context, replayable: context.filter((m) => !skip.has(m.id)), record, selection };
  };

  // What a resumed session keeps from its launch; Codex reasserts model and provider on resume, but an in-flight turn and an omitted effort keep the prior selection.
  const sessionConfigFor = (bot: BotRecord, driverKind: string, model: string | undefined, effort: string | undefined) => {
    const rules = deps.everyBotRules()?.trim();
    const persistentConfig = [bot.name, bot.title, bot.description, deps.sectionPrompt(bot.section), ...(rules ? [rules] : []), ...(driverKind === "codex" ? [model, effort ?? null] : [])];
    return (soul: string | undefined): string => createHash("sha256").update(JSON.stringify([...persistentConfig, soul])).digest("hex").slice(0, 16);
  };

  return { replayInputs, sessionConfigFor };
}
