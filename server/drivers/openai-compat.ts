// OpenAI-compatible driver — any endpoint that speaks the OpenAI
// chat-completions shape (OpenRouter, Groq, Together, a local llama.cpp,
// …). This is the "free models" entry point: point it at OpenRouter's
// free tier or Groq's open-model endpoints and a bot runs without a
// paid Claude/Codex/Grok subscription.
//
// Transcript-replay like grok.ts: the harness folds thread history and
// hands it back each turn (SendTurnInput.transcript); we emit true
// token-level content.delta events and supply generateText.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "openai-compat";

// Default catalog — overwritten by /models when the endpoint answers.
// Free-tier-friendly defaults so the picker is never empty.
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
  ],
};

export interface OpenAICompatConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
  /** Env var (instance environment or process.env) carrying the API key. */
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url:
      typeof o.url === "string" && o.url
        ? o.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No CLI to install — the "install" is getting a free API key.
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.openmausbot\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey =
      input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    let catalog = DEFAULT_MODELS;

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages, stream: opts.stream }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `upstream HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          usage: json.usage
            ? {
                input: json.usage.prompt_tokens ?? 0,
                output: json.usage.completion_tokens ?? 0,
              }
            : null,
        };
      }
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
      }
      return { text, usage };
    };

    const fetchModels = async (): Promise<void> => {
      if (!apiKey) return;
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const json: any = await res.json();
        const rows: Array<{ id?: unknown; name?: unknown }> = Array.isArray(json)
          ? json
          : Array.isArray(json?.data)
            ? json.data
            : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label =
            typeof row.name === "string" && row.name.trim()
              ? row.name
              : id;
          options.push({ id, label });
        }
        if (options.length) {
          catalog = { default: options[0].id, options };
        }
      } catch {
        // keep DEFAULT_MODELS — never fail the instance on a catalog miss
      }
    };
    if (apiKey) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) {
        throw new Error(
          `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        );
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, {
        dir: "out",
        source: "openai-compat.chat.completions",
        // Native logs are diagnostic artifacts users commonly attach to
        // issues. Keep routing metadata, not prompts or transcript content.
        msg: { model: turn.model ?? catalog.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? catalog.default,
      });

      (async () => {
        try {
          const { text, usage } = await complete(
            messages,
            turn.model || catalog.default,
            {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) =>
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta,
                }),
            },
          );
          appendNative(threadId, {
            dir: "in",
            source: "openai-compat.chat.completions",
            msg: { textLength: text.length, usage },
          });
          if (text.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text,
            });
          }
          if (usage) {
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              ...usage,
            });
          }
          active.delete(threadId);
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
            ...(usage ? { usage } : {}),
          });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: (e as Error).message,
            });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "metered" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete(
          [{ role: "user", content: prompt }],
          catalog.default,
          { stream: false },
        );
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
