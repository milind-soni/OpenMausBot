import { createHash } from "node:crypto";
import { DEFAULT_REBUILD_BYTES, replayToolCalls, selectReplay } from "../context-rebuild.ts";
import type { ContextMessage } from "../delta-context.ts";
import { sinceFreshStart } from "../fresh-start.ts";
import { resumePlan } from "../resume-plan.ts";
import type { BotRecord, Message, Store, TaskRecord } from "../store.ts";
import type { CompactConversationInput } from "./conversation-compaction.ts";

type Compaction = NonNullable<Parameters<typeof selectReplay>[1]>["compaction"];

export interface ResumeCheckDeps {
  store: Pick<Store, "taskByThread" | "activePath">;
  directContext(bot: BotRecord, threadId: string, messages: Message[]): ContextMessage[];
  latestCompaction(messages: readonly Message[]): Compaction;
  context(): { rebuildBytes?: number; replayToolHistory?: boolean } | undefined;
  everyBotRules(): string | undefined;
  sectionPrompt(section: string | undefined): string;
  folderToFollow(bot: BotRecord, threadId: string, task: TaskRecord, driverKind: string): string | undefined;
  externalMarker(lastInstanceId: string | undefined): string | undefined;
  strictResume(instanceId: string): boolean;
  currentBot(botId: string, threadId: string): BotRecord | null;
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

  const nextTurnResumes = (input: CompactConversationInput, session: string): boolean => {
    const { threadId, instance } = input;
    const bot = deps.currentBot(input.bot.id, threadId);
    const task = deps.store.taskByThread(input.bot.id, threadId);
    if (!bot || !task || bot.modelSelection.instanceId !== instance.instanceId) return false;
    const { model, effort } = bot.modelSelection;
    const { context, replayable, record, selection } = replayInputs(bot, threadId, sinceFreshStart(deps.store.activePath(threadId)), input.excludedIds);
    const plan = resumePlan({ task, instanceId: instance.instanceId, strictResume: deps.strictResume(instance.instanceId), compacted: selection.compacted, recordId: record?.id,
      folderChanged: deps.folderToFollow(bot, threadId, task, instance.driverKind) !== undefined, contextOrder: context.map((m) => m.id), replayable,
      externalMarker: deps.externalMarker(task.lastInstanceId), coordinationResumed: false, effort });
    return plan.cursor === session && plan.resumes(sessionConfigFor(bot, instance.driverKind, model, effort)(bot.soul));
  };

  return { replayInputs, sessionConfigFor, nextTurnResumes };
}
