import { randomUUID } from "node:crypto";
import { selectReplay } from "../context-rebuild.ts";
import type { ContextMessage } from "../delta-context.ts";
import { draftSummary, foldPoint, type CheckpointSource } from "../compaction-summary.ts";
import { compactBudget, compactionReading, contextWindowFor, shouldCompact } from "../context-budget.ts";
import { autoCompactWindow } from "../drivers/claude-checkpoint.ts";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { UsageRow } from "../usage-ledger.ts";

export function createConversationCompaction(deps: {
  store(): Store;
  config(): AppConfig;
  watchdog(): { setCheckpointOwnsDeadline(threadId: string, value: boolean): void };
  directContext(bot: BotRecord, threadId: string, messages: Message[]): ContextMessage[];
  latestCompaction(messages: readonly Message[]): (NonNullable<Message["compaction"]> & { id: string }) | undefined;
  bookUsage(row: Omit<UsageRow, "at">, countsKnown: boolean, threadId: string): void;
  assertBudget(): void;
  isCurrent(botId: string, generation: string, threadId: string): boolean;
  stoppedError(): Error;
}) {
  const compactionControllers = new Map<string, { generation: string; controller: AbortController }>();
 async function compactConversation(input: {
  bot: BotRecord; threadId: string; generation: string;
  instance: ProviderInstance; model: string;
  excludedIds: ReadonlySet<string>; manual: boolean;
}): Promise<void> {
  const { bot, threadId, generation, instance, model, excludedIds, manual } = input;
  const store = deps.store();
  const cfg = deps.config();
  const task = store.taskByThread(bot.id, threadId);
  if (!task || (!manual && cfg.context?.autoCompact === false)) return;
  const messages = store.activePath(threadId);
  const context = deps.directContext(bot, threadId, messages);
  const record = deps.latestCompaction(messages);
  // A retry must apply the existing record before considering another fold.
  if (!manual && record && record.id !== task.appliedCompactionId) return;
  if (manual && record?.id === messages.at(-1)?.id && !record?.firstKeptId) return;
  const selected = selectReplay(context, { excludedIds, compaction: record });
  const history = selected.transcript.filter(entry => entry.id);
  if (!history.length) return;
  const measurement = compactionReading(instance.adapter.capabilities, task.lastContextModel === `${instance.instanceId}:${model}` && !task.rewound ? task.usage?.context : undefined);
  const window = contextWindowFor(model, instance.models, measurement?.window);
  const bytes = history.reduce((n, entry) => n + Buffer.byteLength(entry.text), 0);
  let floor = task.contextFloor;
  if (record && record.id === task.appliedCompactionId && floor === undefined && measurement?.tokens) {
    floor = measurement.tokens;
    store.patchTask(bot.id, threadId, { contextFloor: floor });
  }
  const nativeCompactAt = instance.driverKind === "claudeAgent"
    ? Number(autoCompactWindow({ ...process.env, ...cfg.instances?.[instance.instanceId]?.environment })) : undefined;
  if (!manual && !shouldCompact({ contextTokens: measurement?.tokens, estimatedBytes: bytes,
    budget: compactBudget(window, cfg.context?.compactAt, nativeCompactAt), floor, window, nativeCompactAt })) return;
  // Native engines without this helper retain their own compaction policy.
  // A manual request reports the unsupported operation rather than losing data.
  if (!manual && !instance.generateCheckpoint) return;
  const fold = manual ? { folded: history, firstKeptId: "" } : foldPoint(history, 2, cfg.context?.checkpointTailTokens);
  if (!fold) return;
  const foldedThroughId = manual
    ? context.findLast(entry => !excludedIds.has(entry.id))?.id
    : fold.folded.at(-1)?.id;
  if (!foldedThroughId) return;
  const prefix = JSON.stringify(messages);
  const controller = new AbortController();
  compactionControllers.set(threadId, { generation, controller });
  try {
    const sourceById = new Map(messages.map(message => [message.id, message]));
    // Older records did not preserve instruction provenance. Re-read the
    // durable raw prefix once instead of inventing authority from their prose.
    const legacy = selected.compacted > 0 && record?.requirements === undefined;
    const sourceHistory = legacy ? context.slice(0, context.findIndex(entry => entry.id === foldedThroughId) + 1) : fold.folded;
    const sources: CheckpointSource[] = sourceHistory.filter(entry => entry.text && sourceById.get(entry.id)?.kind !== "compaction" && !(selected.compacted && entry.id === record?.id) && !excludedIds.has(entry.id)).map(entry => {
      const source = sourceById.get(entry.id);
      // The digest includes an assistant reply; only its observed fields are
      // receipt evidence for the checkpoint helper.
      if (source?.digest) return { ...entry, sourceKind: "receipt", text: JSON.stringify({ tools: source.digest.tools, files: source.digest.files, memory: source.digest.memory, hookCoverage: source.digest.hookCoverage }) };
      return { ...entry, sourceKind: context.find(item => item.id === entry.id)?.sourceKind ?? "assistant" };
    });
    deps.watchdog().setCheckpointOwnsDeadline(threadId, true);
    const checkpoint = await draftSummary(sources, {
      signal: controller.signal, generateCheckpoint: instance.generateCheckpoint ? (prompt, options) => {
        deps.assertBudget();
        return instance.generateCheckpoint!(prompt, options);
      } : undefined, model, window,
      previous: selected.compacted && record && !legacy ? { summary: record.summary, requirements: record.requirements ?? [] } : undefined,
      outputTokens: cfg.context?.checkpointOutputTokens, prefillTimeoutMs: cfg.context?.checkpointPrefillTimeoutMs,
      idleTimeoutMs: cfg.context?.checkpointIdleTimeoutMs,
      previousReceiptIds: new Set(selected.compacted && record && !legacy ? messages.slice(0, messages.findIndex(message => message.id === record.foldedThroughId) + 1).filter(message => message.digest).map(message => message.id) : []),
      onUsage: usage => deps.bookUsage({ botId: bot.id, botName: bot.name, threadId: `checkpoint-${threadId}-${randomUUID()}`,
        instanceId: instance.instanceId, driverKind: instance.driverKind, model: usage.model,
        input: usage.input ?? 0, output: usage.output ?? 0,
        ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}), costUsd: usage.costUsd ?? null,
        trigger: { kind: "bot", botId: bot.id } }, usage.input !== undefined && usage.output !== undefined, threadId),
    });
    if (!deps.isCurrent(bot.id, generation, threadId)) throw deps.stoppedError();
    controller.signal.throwIfAborted();
    if (prefix !== JSON.stringify(store.activePath(threadId).slice(0, messages.length))) {
      if (manual) throw new Error("the conversation changed during summarization — please retry");
      return;
    }
    store.appendMessage(threadId, {
      role: "bot", kind: "compaction",
      compaction: { ...checkpoint, firstKeptId: fold.firstKeptId, foldedThroughId,
        tokensBefore: measurement?.tokens ?? Math.ceil(bytes / 4), by: manual ? "person" : "harness" },
    }, { kind: "compaction.append", key: `${threadId}:${messages.at(-1)?.id}:${fold.firstKeptId}` });
  } finally {
    if (compactionControllers.get(threadId)?.generation === generation) {
      compactionControllers.delete(threadId);
      deps.watchdog().setCheckpointOwnsDeadline(threadId, false);
    }
  }
}

  return {
    compactConversation,
    abort(threadId: string, generation: string, error: Error) {
      const compacting = compactionControllers.get(threadId);
      if (compacting?.generation === generation) compacting.controller.abort(error);
    },
  };
}
