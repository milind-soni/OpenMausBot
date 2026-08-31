import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Usage {
  input: number;
  output: number;
}

interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
}

interface CompletionJson {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string): unknown;
  incoming(completion: Completion): unknown;
}

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** Shared runtime for the three providers that speak OpenAI chat completions. */
export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, AbortController>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
  ): Promise<Completion> => {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const response = await fetch(`${options.apiUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(options.requestBody(model, messages, stream)),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    if (!stream) {
      const json = await response.json() as CompletionJson;
      const message = json.choices?.[0]?.message;
      return {
        text: typeof message?.content === "string" ? message.content : "",
        reasoning: options.reasoning && typeof message?.reasoning_content === "string"
          ? message.reasoning_content
          : "",
        usage: usageFrom(json.usage),
      };
    }

    if (!response.body) {
      throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
    }
    let text = "";
    let reasoning = "";
    let usage: Usage | null = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break readLoop;
          let chunk: CompletionJson;
          try {
            chunk = JSON.parse(data) as CompletionJson;
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          const reasoningDelta = options.reasoning && typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
          const contentDelta = typeof delta?.content === "string" ? delta.content : "";
          if (reasoningDelta) {
            reasoning += reasoningDelta;
            onDelta?.(reasoningDelta, "reasoning_text");
          }
          if (contentDelta) {
            text += contentDelta;
            onDelta?.(contentDelta, "assistant_text");
          }
          if (chunk.usage) usage = usageFrom(chunk.usage);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { text, reasoning, usage };
  };

  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => [
    ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
    ...(turn.transcript ?? []).map((message) => ({
      role: message.role,
      content: message.text,
    })),
    { role: "user", content: turn.text },
  ];

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const model = turn.model || options.models().default;
    active.set(turn.threadId, abort);
    appendNative(turn.threadId, {
      dir: "out",
      source: options.nativeLog.source,
      msg: options.nativeLog.outgoing(turn, messages, model),
    });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let attempt = 0;
      let streamedText = false;
      for (;;) {
        try {
          const completion = await complete(messages, model, true, abort.signal, (delta, streamKind) => {
            if (streamKind === "assistant_text") streamedText = true;
            emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind, delta });
          });
          appendNative(turn.threadId, {
            dir: "in",
            source: options.nativeLog.source,
            msg: options.nativeLog.incoming(completion),
          });
          const reply = completion.text.trim() ? completion.text : completion.reasoning;
          if (reply.trim()) {
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: reply });
          }
          if (completion.usage) {
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...completion.usage });
          }
          active.delete(turn.threadId);
          const completed: RuntimeEvent = {
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
          };
          emit(options.includeUsageInCompleted && completion.usage
            ? { ...completed, usage: completion.usage }
            : completed);
          return;
        } catch (value) {
          const error = asError(value);
          const aborted = error.name === "AbortError";
          const verdict = classifyError(error);
          if (
            options.retryScale !== undefined &&
            !aborted &&
            !streamedText &&
            verdict.transient &&
            attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            const delayMs = computeBackoff(attempt++);
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.retrying",
              attempt,
              delayMs,
              reason: verdict.reason,
            });
            const outcome = await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
            if (outcome === "elapsed" && !abort.signal.aborted) continue;
            active.delete(turn.threadId);
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
            return;
          }
          active.delete(turn.threadId);
          if (!aborted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error.message });
          emit({
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
          return;
        }
      }
    })();
    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    snapshot: async () => options.apiKey
      ? { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : { state: "unavailable", reason: options.unavailableReason },
    adapter: {
      provider: options.driverKind,
      capabilities: { sessionModelSwitch: "in-session" },
      sendTurn,
      interruptTurn: async (threadId) => active.get(threadId)?.abort(),
      respondToRequest: async () => "unavailable" as const,
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        for (const abort of active.values()) abort.abort();
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning } = await complete([{ role: "user", content: prompt }], model, false);
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      for (const abort of active.values()) abort.abort();
      listeners.clear();
    },
  };
}
