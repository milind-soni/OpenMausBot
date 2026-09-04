// OpenMaus Runtime: the harness owns the whole loop.
//
// Every other engine hands the inner model/tool loop to an installed CLI or a
// one-shot chat endpoint. This one runs it in-process — model call, tool
// call, approval, steering, cancellation — against any OpenAI-compatible
// endpoint the user supplies a key for (OpenRouter, Groq, llama.cpp, a local
// server). It reuses openai-compat's configuration and key contract exactly,
// so switching a bot between the two is a per-bot engine choice and nothing
// else moves.
//
// It does NOT reuse a Claude or Codex subscription login. It never reads
// another CLI's auth files. Authentication here is an API key or a local
// endpoint that needs none, and usage is billed by that provider.
//
// Preview: disabled unless config.features.ownedRuntime is true. No MCP
// integrations are mounted yet — those capabilities are advertised only
// after each one is proven.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { contextLimitsFor } from "../context/budget.ts";
import type { OwnedAgentRuntime, OwnedRuntimeEvent } from "../runtime/contracts.ts";
import { createPiRuntime } from "../runtime/pi-runtime.ts";
import { appendNative } from "./native.ts";

export const OPENMAUS_RUNTIME_KIND = "openmaus-runtime";

/** The plan's Task 9 bounds, plumbed from day one so the loop has never
 * run unbounded. Repeat detection and the advisory land with Task 9. */
export const OWNED_LOOP_LIMITS = { maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 180_000 } as const;

const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

export interface OpenMausRuntimeConfig {
  url: string;
  apiKeyEnv: string;
  key?: string;
  model?: string;
  provider?: string;
}

/** Same envelope as openai-compat, on purpose: the two engines are
 * interchangeable per bot, and a config that works for one works for the
 * other. */
function decodeConfig(raw: unknown): OpenMausRuntimeConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv ? config.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model ? config.model : process.env.OPENAI_COMPAT_MODEL || undefined,
    provider: typeof config.provider === "string" && config.provider
      ? config.provider
      : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

const NO_KEY = (env: string) => `no API key — set ${env} or add it to the instance config`;

export interface CreateOpenMausRuntimeOptions {
  /** injected by tests; production uses the Pi-backed runtime. */
  runtime?: OwnedAgentRuntime;
}

export function createOpenMausRuntimeInstance(
  input: DriverCreateInput<OpenMausRuntimeConfig>,
  options: CreateOpenMausRuntimeOptions = {},
): ProviderInstance {
  const { config } = input;
  const apiKey =
    config.key ??
    input.environment[config.apiKeyEnv] ??
    input.environment.OPENAI_COMPAT_API_KEY ??
    process.env[config.apiKeyEnv] ??
    process.env.OPENAI_COMPAT_API_KEY ??
    "";
  const catalog: ModelCatalog = config.model
    ? {
        default: config.model,
        options: DEFAULT_MODELS.options.some((model) => model.id === config.model)
          ? DEFAULT_MODELS.options
          : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
      }
    : DEFAULT_MODELS;

  const runtime = options.runtime ?? createPiRuntime();
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, AbortController>();
  const emit = (event: RuntimeEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: OPENMAUS_RUNTIME_KIND,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  /** The whole OwnedRuntimeEvent → RuntimeEvent mapping, in one place. */
  const forward = (threadId: string, turnId: string) => (event: OwnedRuntimeEvent) => {
    const b = base(threadId, turnId);
    switch (event.type) {
      case "model.call":
        return;
      case "delta":
        emit({ ...b, type: "content.delta", streamKind: event.kind === "text" ? "assistant_text" : "reasoning_text", delta: event.text });
        return;
      case "tool.started":
        emit({ ...b, itemId: event.callId, type: "item.started", itemType: "tool", title: event.name });
        return;
      case "tool.completed":
        emit({ ...b, itemId: event.callId, type: "item.completed", itemType: "tool", ok: event.ok });
        return;
      case "assistant":
        emit({ ...b, type: "item.completed", itemType: "assistant_text", text: event.text });
        return;
      case "usage":
        emit({ ...b, type: "thread.token-usage.updated", input: event.input, output: event.output, ...(event.cachedInput ? { cachedInput: event.cachedInput } : {}) });
        return;
      case "error":
        emit({ ...b, type: "runtime.error", message: event.message });
        return;
      case "completed":
        active.delete(threadId);
        emit({
          ...b,
          type: "turn.completed",
          ok: event.ok,
          stopReason: event.ok ? (event.stopReason === "end_turn" ? null : event.stopReason) : event.stopReason,
          cost: null,
        });
        return;
    }
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!apiKey) throw new Error(NO_KEY(config.apiKeyEnv));
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    // For an omb-loop engine the plan is not a compatibility projection, it
    // is the only history there is. Refusing a planless turn is how a
    // future caller learns that, instead of the model silently starting
    // from nothing.
    if (!turn.context) throw new Error("openmaus-runtime requires SendTurnInput.context");

    const turnId = newId();
    const abort = new AbortController();
    const model = turn.model || catalog.default;
    const limits = contextLimitsFor(model, catalog);
    active.set(turn.threadId, abort);
    appendNative(turn.threadId, {
      dir: "out",
      source: "openmaus-runtime.turn",
      msg: { model, items: turn.context.messages.length, ownership: turn.context.ownership },
    });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void runtime.run(
      {
        threadId: turn.threadId,
        turnId,
        plan: turn.context,
        system: turn.system,
        model: {
          id: model,
          baseUrl: config.url,
          ...(apiKey ? { apiKey } : {}),
          contextWindow: limits.contextWindow,
          // pi needs a ceiling; the projector's share-of-window budget has
          // already left room for the answer
          maxOutputTokens: 4_096,
          reasoning: true,
          ...(config.provider ? { openRouterProvider: config.provider } : {}),
        },
        effort: turn.effort,
        tools: [],
        signal: abort.signal,
        limits: OWNED_LOOP_LIMITS,
      },
      forward(turn.threadId, turnId),
    ).catch((error: unknown) => {
      // run() is contracted never to reject for model/tool failures; this is
      // the belt for a bug in the adapter itself, so the thread is not left
      // busy forever
      active.delete(turn.threadId);
      emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
      emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
    });
    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: OPENMAUS_RUNTIME_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    models: catalog,
    snapshot: async () => apiKey
      ? { state: "available", authenticated: true, version: null, billing: "metered" }
      : { state: "unavailable", reason: NO_KEY(config.apiKeyEnv) },
    adapter: {
      provider: OPENMAUS_RUNTIME_KIND,
      capabilities: {
        sessionModelSwitch: "in-session",
        contextOwnership: "omb-loop",
        // the loop takes a user message before its next model call
        queueing: true,
        images: false,
        effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        // no MCP capability is advertised until its integration test passes
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        active.get(threadId)?.abort();
        runtime.interrupt(threadId);
      },
      respondToRequest: async () => "unavailable" as const,
      steer: async (threadId, text) => runtime.steer(threadId, text),
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        for (const abort of active.values()) abort.abort();
        await runtime.dispose();
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      for (const abort of active.values()) abort.abort();
      await runtime.dispose();
      listeners.clear();
    },
  };
}

export const OpenMausRuntimeDriver: ProviderDriver<OpenMausRuntimeConfig> = {
  driverKind: OPENMAUS_RUNTIME_KIND,
  metadata: {
    displayName: "OpenMaus Runtime (preview)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENAI_COMPAT_API_KEY). "
      + "This engine uses an API key, not a Claude or Codex login, and usage is billed by that provider.",
    command: {
      darwin: "Get a key at https://openrouter.ai/keys (or run a local OpenAI-compatible server) and add it under openaiCompat.key in ~/.openmausbot/config.json",
      linux: "Get a key at https://openrouter.ai/keys (or run a local OpenAI-compatible server) and add it under openaiCompat.key in ~/.openmausbot/config.json",
      win32: "Get a key at https://openrouter.ai/keys (or run a local OpenAI-compatible server) and add it under openaiCompat.key in %USERPROFILE%\\.openmausbot\\config.json",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    return createOpenMausRuntimeInstance(input);
  },
};
