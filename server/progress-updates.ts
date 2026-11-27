// Opt-in background progress updates for long-running direct turns using OpenMausBot's native sideJobs.
// Disabled by default: enable via config.json (`progressUpdates: { enabled: true }`) or `OMB_PROGRESS_UPDATES=1`.
import { z } from "zod";
import { redactSecretsInText } from "./redact.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { Message } from "./store.ts";
import type { SideJobs } from "./side-jobs.ts";

export const progressUpdatesStoredShape = {
  progressUpdates: z.object({
    enabled: z.boolean().optional(),
    firstAfterSeconds: z.number().int().min(10).max(3600).optional(),
    intervalSeconds: z.number().int().min(15).max(3600).optional(),
    maxPerTurn: z.number().int().min(1).max(30).optional(),
  }).optional().catch(undefined),
};

export interface ProgressUpdatesConfig {
  progressUpdates?: {
    enabled?: boolean;
    firstAfterSeconds?: number;
    intervalSeconds?: number;
    maxPerTurn?: number;
  };
}

export interface EffectiveProgressConfig {
  enabled: boolean;
  firstAfterMs: number;
  intervalMs: number;
  maxPerTurn: number;
}

const DEFAULT_FIRST_AFTER_MS = 90_000;
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_MAX_PER_TURN = 6;
const STREAMING_GRACE_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const GENERATE_TIMEOUT_MS = 25_000;
const NORMAL_TOOL_RUN_MS = 150_000;

export function progressUpdatesConfig(
  cfg: ProgressUpdatesConfig,
  env: Record<string, string | undefined> = process.env,
): EffectiveProgressConfig {
  const envFlag = env.OMB_PROGRESS_UPDATES?.trim();
  const enabled = envFlag === "0" ? false : envFlag === "1" ? true : cfg.progressUpdates?.enabled === true;
  const firstAfterMs = Math.max(10_000, (cfg.progressUpdates?.firstAfterSeconds ?? DEFAULT_FIRST_AFTER_MS / 1000) * 1000);
  const intervalMs = Math.max(15_000, (cfg.progressUpdates?.intervalSeconds ?? DEFAULT_INTERVAL_MS / 1000) * 1000);
  const maxPerTurn = Math.min(30, Math.max(1, cfg.progressUpdates?.maxPerTurn ?? DEFAULT_MAX_PER_TURN));
  return { enabled, firstAfterMs, intervalMs, maxPerTurn };
}

interface ToolRunState {
  id: string;
  name: string;
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
}

interface TurnWatch {
  threadId: string;
  botId: string;
  botName: string;
  generation: number;
  startedAt: number;
  lastActivityAt: number;
  lastAssistantDeltaAt: number;
  completedTools: number;
  runningTools: Map<string, ToolRunState>;
  recentTools: ToolRunState[];
  reasoningTail: string;
  assistantTextTail: string;
  waitingOnHuman: boolean;
  waitingKind: "approval" | "question" | null;
  waitingSummary: string | null;
  reportsPosted: number;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export interface ProgressUpdatesDeps {
  bus: { subscribe(listener: (event: RuntimeEvent) => void): () => void };
  store: {
    messagesFor(threadId: string): ReadonlyArray<Pick<Message, "role" | "kind" | "text" | "progressUpdate">>;
    appendMessage(threadId: string, message: Omit<Message, "id" | "at">): unknown;
  };
  sideJobs: Pick<SideJobs, "text">;
  botForThread(threadId: string): { id: string; name: string } | undefined;
  isInternalTurn(threadId: string): boolean;
  isRoutineTurn(threadId: string): boolean;
  isThreadBusy(botId: string, threadId: string): boolean;
  shouldIgnoreProviderEvent(event: RuntimeEvent): boolean;
  getConfig(): EffectiveProgressConfig;
}

function appendTail(current: string, chunk: string, maxLen: number): string {
  const combined = `${current}${chunk}`;
  return combined.length > maxLen ? combined.slice(-maxLen) : combined;
}

function initialUserRequest(messages: ReadonlyArray<Pick<Message, "role" | "kind" | "text" | "progressUpdate">>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && (m.kind === undefined || m.kind === "text") && !m.progressUpdate && typeof m.text === "string" && m.text.trim()) {
      return redactSecretsInText(m.text.trim()).slice(0, 700);
    }
  }
  return "";
}

function buildProgressPrompt(watch: TurnWatch, initialPrompt: string, now: number): string {
  const payload = {
    botName: watch.botName,
    initialRequest: initialPrompt || "(none)",
    elapsedSeconds: Math.max(1, Math.round((now - watch.startedAt) / 1000)),
    silentSeconds: Math.max(0, Math.round((now - watch.lastActivityAt) / 1000)),
    completedTools: watch.completedTools,
    waitingOnHuman: watch.waitingOnHuman,
    waitingKind: watch.waitingKind,
    waitingSummary: watch.waitingSummary ? redactSecretsInText(watch.waitingSummary).slice(0, 180) : null,
    runningTools: [...watch.runningTools.values()].slice(-4).map((t) => ({
      name: t.name.slice(0, 80),
      runningSeconds: Math.max(1, Math.round((now - t.startedAt) / 1000)),
    })),
    recentTools: watch.recentTools.slice(-5).map((t) => ({
      name: t.name.slice(0, 80),
      ok: t.ok,
      durationSeconds: t.durationMs !== undefined ? Math.round(t.durationMs / 1000) : undefined,
    })),
    reasoningTail: redactSecretsInText(watch.reasoningTail).slice(-700),
    assistantTextTail: redactSecretsInText(watch.assistantTextTail).slice(-600),
  };
  return [
    "Write a single concise first-person status update (one short sentence, <= 120 chars, plain text, no markdown list or prefix).",
    "Match the language of `initialRequest` (default to English if unclear).",
    "Explain what step is underway and the live state:",
    `- If \`waitingOnHuman\` is true, state clearly that execution is paused waiting for the user's ${payload.waitingKind ?? "approval"} (${payload.waitingSummary ?? "pending prompt"}).`,
    `- Otherwise if \`runningTools\` is non-empty and its longest \`runningSeconds\` < ${Math.round(NORMAL_TOOL_RUN_MS / 1000)}, say the tool is running normally (never call it stalled).`,
    "- Otherwise if `silentSeconds` >= 60 or a tool ran very long, mention that the step is taking longer than usual or awaiting an upstream response.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

function normalizeReply(raw: string): string {
  const singleLine = redactSecretsInText(raw)
    .replace(/\r?\n+/g, " ")
    .replace(/^[-*>#\s`"]+/, "")
    .replace(/[`"]+$/, "")
    .trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 179).trimEnd()}…` : singleLine;
}

export function attachProgressUpdates(deps: ProgressUpdatesDeps): { dispose(): void } {
  const watches = new Map<string, TurnWatch>();
  let nextGeneration = 1;

  const stopWatch = (threadId: string) => {
    const watch = watches.get(threadId);
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    watch.abortController?.abort();
    watch.abortController = null;
    watches.delete(threadId);
  };

  const scheduleNext = (watch: TurnWatch, delayMs: number) => {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void tick(watch);
    }, delayMs);
    watch.timer.unref?.();
  };

  const invalidatePendingAndReschedule = (watch: TurnWatch) => {
    const wasInFlight = watch.abortController !== null;
    if (wasInFlight) {
      watch.generation = nextGeneration++;
      watch.abortController?.abort();
      watch.abortController = null;
    }
    const config = deps.getConfig();
    if ((wasInFlight || watch.timer === null) && config.enabled && watch.reportsPosted < config.maxPerTurn && watch.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      scheduleNext(watch, config.intervalMs);
    }
  };

  async function tick(watch: TurnWatch): Promise<void> {
    if (watches.get(watch.threadId) !== watch) return;
    const config = deps.getConfig();
    if (!config.enabled) { stopWatch(watch.threadId); return; }
    if (deps.isInternalTurn(watch.threadId) || deps.isRoutineTurn(watch.threadId) || !deps.isThreadBusy(watch.botId, watch.threadId)) {
      stopWatch(watch.threadId);
      return;
    }
    if (watch.reportsPosted >= config.maxPerTurn || watch.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopWatch(watch.threadId);
      return;
    }
    const now = Date.now();
    // Avoid interrupting active streaming unless a tool has been running separately for a while.
    if (watch.runningTools.size === 0 && !watch.waitingOnHuman && now - watch.lastAssistantDeltaAt < STREAMING_GRACE_MS) {
      scheduleNext(watch, Math.min(config.intervalMs, STREAMING_GRACE_MS));
      return;
    }

    const sideJob = deps.sideJobs.text("progress-update", watch.botId);
    if (!sideJob) {
      watch.consecutiveFailures += 1;
      if (watch.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        scheduleNext(watch, config.intervalMs * (watch.consecutiveFailures + 1));
      }
      return;
    }

    const generation = watch.generation;
    const controller = new AbortController();
    watch.abortController = controller;
    try {
      const prompt = buildProgressPrompt(watch, initialUserRequest(deps.store.messagesFor(watch.threadId)), now);
      const raw = await sideJob.generateText(prompt, { signal: controller.signal, timeoutMs: GENERATE_TIMEOUT_MS });
      if (controller.signal.aborted || watches.get(watch.threadId) !== watch || watch.generation !== generation) return;
      if (!deps.isThreadBusy(watch.botId, watch.threadId) || deps.isRoutineTurn(watch.threadId)) return;
      const line = normalizeReply(raw);
      if (line) {
        deps.store.appendMessage(watch.threadId, { role: "bot", kind: "text", text: line, progressUpdate: true });
        watch.reportsPosted += 1;
        watch.consecutiveFailures = 0;
      } else {
        watch.consecutiveFailures += 1;
      }
    } catch {
      if (controller.signal.aborted || watches.get(watch.threadId) !== watch || watch.generation !== generation) return;
      watch.consecutiveFailures += 1;
    } finally {
      if (watch.abortController === controller) watch.abortController = null;
    }

    if (watches.get(watch.threadId) === watch && watch.generation === generation && watch.reportsPosted < config.maxPerTurn && watch.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const backoff = watch.consecutiveFailures > 0 ? config.intervalMs * (watch.consecutiveFailures + 1) : config.intervalMs;
      scheduleNext(watch, backoff);
    }
  }

  const unsubscribe = deps.bus.subscribe((event) => {
    if (deps.shouldIgnoreProviderEvent(event)) return;
    if (event.type === "turn.started") {
      stopWatch(event.threadId);
      const config = deps.getConfig();
      if (!config.enabled || deps.isInternalTurn(event.threadId) || deps.isRoutineTurn(event.threadId)) return;
      const bot = deps.botForThread(event.threadId);
      if (!bot) return;
      const now = Date.now();
      const watch: TurnWatch = {
        threadId: event.threadId,
        botId: bot.id,
        botName: bot.name,
        generation: nextGeneration++,
        startedAt: now,
        lastActivityAt: now,
        lastAssistantDeltaAt: 0,
        completedTools: 0,
        runningTools: new Map(),
        recentTools: [],
        reasoningTail: "",
        assistantTextTail: "",
        waitingOnHuman: false,
        waitingKind: null,
        waitingSummary: null,
        reportsPosted: 0,
        consecutiveFailures: 0,
        timer: null,
        abortController: null,
      };
      watches.set(event.threadId, watch);
      scheduleNext(watch, config.firstAfterMs);
      return;
    }

    const watch = watches.get(event.threadId);
    if (!watch) return;
    const now = Date.now();

    if (event.type === "turn.completed" || event.type === "runtime.error" || event.type === "session.exited") {
      stopWatch(event.threadId);
      return;
    }

    if (event.type === "content.delta") {
      watch.lastActivityAt = now;
      if (event.streamKind === "reasoning_text") {
        watch.reasoningTail = appendTail(watch.reasoningTail, event.delta, 900);
      } else if (event.streamKind === "assistant_text") {
        watch.lastAssistantDeltaAt = now;
        watch.assistantTextTail = appendTail(watch.assistantTextTail, event.delta, 800);
      }
      return;
    }

    if (event.type === "item.started" && event.itemType === "tool") {
      watch.lastActivityAt = now;
      const id = event.itemId || `tool-${watch.completedTools + watch.runningTools.size + 1}`;
      watch.runningTools.set(id, { id, name: event.title || "tool", startedAt: now });
      return;
    }

    if (event.type === "item.completed" && event.itemType === "tool") {
      watch.lastActivityAt = now;
      watch.completedTools += 1;
      const id = event.itemId ?? "";
      const running = watch.runningTools.get(id);
      if (running) watch.runningTools.delete(id);
      watch.recentTools.push({
        id: id || `done-${watch.completedTools}`,
        name: running?.name ?? "tool",
        startedAt: running?.startedAt ?? now,
        durationMs: running ? now - running.startedAt : undefined,
        ok: event.ok,
      });
      if (watch.recentTools.length > 8) watch.recentTools.shift();
      return;
    }

    if (event.type === "request.opened") {
      watch.lastActivityAt = now;
      watch.waitingOnHuman = true;
      watch.waitingKind = event.requestType === "permission" && !event.questions?.length ? "approval" : "question";
      watch.waitingSummary = event.summary ?? null;
      invalidatePendingAndReschedule(watch);
      return;
    }

    if (event.type === "request.resolved") {
      watch.lastActivityAt = now;
      watch.waitingOnHuman = false;
      watch.waitingKind = null;
      watch.waitingSummary = null;
      invalidatePendingAndReschedule(watch);
    }
  });

  return {
    dispose: () => {
      unsubscribe();
      for (const threadId of watches.keys()) stopWatch(threadId);
    },
  };
}
