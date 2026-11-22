import { draftSummary, foldPoint } from "../compaction-summary.ts";
import { compactBudget, compactionReading, contextWindowFor, shouldCompact } from "../context-budget.ts";
import { MAX_SUMMARY_BYTES, selectReplay } from "../context-rebuild.ts";
import type { ModelCatalog } from "../contracts.ts";
import type { EngineCompactCheck, EngineCompactOutcome } from "./warm-summary-host.ts";
import type { ContextMessage } from "../delta-context.ts";
import { sinceFreshStart } from "../fresh-start.ts";
import type { BotRecord, Message, Store } from "../store.ts";

const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const set = (value: string | undefined) => Boolean(value && !/^(0|false|no|off)$/i.test(value.trim()));

/** Claude Code 2.1 turns its own compaction off with DISABLE_AUTO_COMPACT or DISABLE_COMPACT in its environment. */
export function claudeCompactionDisabled(env: Record<string, string | undefined>): boolean {
  return set(env.DISABLE_AUTO_COMPACT) || set(env.DISABLE_COMPACT);
}

/** An engine that compacts itself does so below its limit (Claude Code about 33k tokens under its compaction window, Codex
 * at 90% of the model's window), so a session measured this close to the limit was not compacted by its engine. */
export function foldBackstop(window: number, nativeCompactAt?: number): number {
  const limit = positive(nativeCompactAt) ? Math.min(window, nativeCompactAt) : window;
  return Math.floor(Math.max(limit - 10_000, limit * 0.95));
}

/** When OpenMausBot's own fold runs before a turn. An engine that compacts its own session keeps that session: the fold
 * is only the guard for a session its engine left uncompacted. `context.compactAt` set by the person applies to every engine. */
export function foldDue(input: {
  engineCompacts: boolean; configuredCompactAt?: number; contextTokens?: number; estimatedBytes: number;
  window: number; nativeCompactAt?: number; floor?: number; idleFraction?: number;
}): boolean {
  const { window, nativeCompactAt } = input;
  if (input.engineCompacts && !positive(input.configuredCompactAt)) {
    return positive(input.contextTokens) && input.contextTokens >= foldBackstop(window, nativeCompactAt);
  }
  return shouldCompact({ contextTokens: input.contextTokens, estimatedBytes: input.estimatedBytes,
    budget: compactBudget(window, input.configuredCompactAt, nativeCompactAt) * (input.idleFraction ?? 1), floor: input.floor, window, nativeCompactAt });
}

interface CompactionInstance {
  instanceId: string;
  driverKind: string;
  models?: ModelCatalog;
  adapter: { capabilities: { contextReading?: "meter"; nativeCompaction?: boolean } };
}

export interface CompactConversationInput {
  bot: BotRecord; threadId: string; generation: string; instance: CompactionInstance; model: string;
  excludedIds: ReadonlySet<string>; manual: boolean; idle?: AbortSignal;
}

export interface ConversationCompactionDeps {
  store: Pick<Store, "taskByThread" | "activePath" | "patchTask" | "appendMessage">;
  context(): { autoCompact?: boolean; compactAt?: number } | undefined;
  directContext(bot: BotRecord, threadId: string, messages: Message[]): ContextMessage[];
  latestCompaction(messages: readonly Message[]): ({ id: string; firstKeptId?: string } & Record<string, unknown>) | undefined;
  /** Where the engine compacts by itself, in tokens, when OpenMausBot set that point. */
  nativeCompactTokens(instance: CompactionInstance, model: string): number | undefined;
  /** False for an engine whose own compaction is switched off in its environment. */
  engineCompactionOn(instance: CompactionInstance): boolean;
  /** The engine's own compaction of this conversation's session, asked for by the person; `skipped` when it has none to offer now. */
  engineCompact(target: { botId: string; threadId: string; instanceId: string }, signal: AbortSignal, check: EngineCompactCheck): Promise<EngineCompactOutcome>;
  /** Whether the conversation's next turn carries on `session`, by the decision that turn makes before it dispatches. */
  resumesSession(input: CompactConversationInput, session: string): boolean;
  /** The engine instance and model the conversation's next turn would run on now. */
  currentSelection(botId: string, threadId: string): { instanceId: string; model: string | null } | undefined;
  generateText(botId: string, instance: CompactionInstance): ((prompt: string, options?: { signal?: AbortSignal }) => Promise<string>) | undefined;
  claimIsCurrent(botId: string, generation: string, threadId: string): boolean;
  controllers: Map<string, { generation: string; controller: AbortController }>;
  cancelled(reason: string): Error;
  idleFraction: number;
  /** Told true when a summary of a conversation someone is waiting on starts, and false once it is written, failed or stopped. */
  summarizing?(threadId: string, active: boolean): void;
}

export function createConversationCompaction(deps: ConversationCompactionDeps) {
  const { store } = deps;
  return async function compactConversation(input: CompactConversationInput): Promise<void> {
    const { bot, threadId, generation, instance, model, excludedIds, manual, idle } = input;
    const task = store.taskByThread(bot.id, threadId);
    const settings = deps.context();
    if (!task || (!manual && settings?.autoCompact === false)) return;
    const messages = sinceFreshStart(store.activePath(threadId));
    const context = deps.directContext(bot, threadId, messages);
    const record = deps.latestCompaction(messages) as ({ id: string; firstKeptId?: string; summary: string; foldedThroughId?: string } | undefined);
    // A retry must apply the existing record before considering another fold.
    if (!manual && record && record.id !== task.appliedCompactionId) return;
    if (manual && record?.id === messages.at(-1)?.id && !record?.firstKeptId) return;
    if (manual && messages.at(-1)?.kind === "compaction" && messages.at(-1)?.engineCompaction) return;
    const selected = selectReplay(context, {
      budgetBytes: Math.max(1_024, context.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0) + 4 * MAX_SUMMARY_BYTES + 1_024),
      maxMessages: Number.MAX_SAFE_INTEGER, excludedIds, compaction: record as never,
    });
    const history = selected.transcript.filter(entry => entry.id);
    if (!history.length) return;
    const measurement = compactionReading(instance.adapter.capabilities, task.lastContextModel === `${instance.instanceId}:${model}` && !task.rewound ? task.usage?.context : undefined);
    const window = contextWindowFor(model, instance.models, measurement?.window);
    const bytes = history.reduce((n, entry) => n + Buffer.byteLength(entry.text), 0);
    let floor = task.contextFloor, seededFloor = false;
    if (record && record.id === task.appliedCompactionId && floor === undefined && measurement?.tokens) {
      floor = measurement.tokens;
      seededFloor = true;
      if (!manual) store.patchTask(bot.id, threadId, { contextFloor: floor });
    }
    const engineCompacts = instance.adapter.capabilities.nativeCompaction === true && deps.engineCompactionOn(instance);
    if (!manual && !foldDue({ engineCompacts, configuredCompactAt: settings?.compactAt, contextTokens: measurement?.tokens, estimatedBytes: bytes,
      window, nativeCompactAt: deps.nativeCompactTokens(instance, model), floor, idleFraction: idle ? deps.idleFraction : 1 })) return;
    const fold = manual ? { folded: history, firstKeptId: "" } : foldPoint(history);
    if (!fold) return;
    const foldedThroughId = manual
      ? context.findLast(entry => !excludedIds.has(entry.id))?.id
      : fold.folded.at(-1)?.id;
    if (!foldedThroughId) return;
    const prefix = JSON.stringify(messages);
    const controller = new AbortController();
    idle?.addEventListener("abort", () => controller.abort(), { once: true });
    if (idle?.aborted) controller.abort();
    deps.controllers.set(threadId, { generation, controller });
    // Someone waits on this summary (not an idle one): the status line says so until every way out below, in the finally.
    let shown = false;
    try {
      const engine = manual && engineCompacts ? await deps.engineCompact({ botId: bot.id, threadId, instanceId: instance.instanceId }, controller.signal, {
        model, compactAtSet: positive(settings?.compactAt), resumes: (session) => deps.resumesSession(input, session), selectionNow: () => deps.currentSelection(bot.id, threadId),
        current: () => deps.claimIsCurrent(bot.id, generation, threadId),
      }) : "skipped";
      controller.signal.throwIfAborted();
      if (engine !== "skipped") return;
      if (seededFloor && manual) store.patchTask(bot.id, threadId, { contextFloor: floor });
      if (!idle && deps.summarizing) { shown = true; deps.summarizing(threadId, true); }
      const summary = await draftSummary(fold.folded, { signal: controller.signal, generateText: deps.generateText(bot.id, instance) });
      if (!idle && !deps.claimIsCurrent(bot.id, generation, threadId)) throw deps.cancelled("context summarization stopped");
      controller.signal.throwIfAborted();
      if (prefix !== JSON.stringify(sinceFreshStart(store.activePath(threadId)).slice(0, messages.length))) {
        if (manual) throw new Error("the conversation changed during summarization — please retry");
        return;
      }
      store.appendMessage(threadId, {
        role: "bot", kind: "compaction",
        compaction: { summary, firstKeptId: fold.firstKeptId, foldedThroughId,
          tokensBefore: measurement?.tokens ?? Math.ceil(bytes / 4), by: manual ? "person" : "harness" },
      }, { kind: "compaction.append", key: `${threadId}:${messages.at(-1)?.id}:${fold.firstKeptId}` });
    } finally {
      if (shown) deps.summarizing?.(threadId, false);
      if (deps.controllers.get(threadId)?.generation === generation) deps.controllers.delete(threadId);
    }
  };
}
