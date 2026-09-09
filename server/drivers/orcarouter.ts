// OrcaRouter driver — OpenAI-compatible chat/completions API with SSE
// streaming. OrcaRouter is an OpenAI-compatible AI gateway exposing a
// provider/model namespace like OpenRouter, plus adaptive routing, automatic
// failover, zero-markup inference, observability, guardrails, and agent-tool
// governance on the same endpoint.
//
// Model ids carry the full `provider/model` slug (e.g. `orcarouter/fusion`,
// `deepseek/deepseek-v4-flash-0731`); the endpoint resolves routing itself.
// Like the other API-key drivers, this one reads its key from the instance
// environment or process.env and reports unavailable until one is present.
//
// API: https://api.orcarouter.ai/v1/chat/completions
// Models: https://api.orcarouter.ai/v1/models

import { z } from "zod";

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

const DRIVER_KIND = "orcarouter";
const API_KEY_ENV = "ORCAROUTER_API_KEY";
const DEFAULT_URL = "https://api.orcarouter.ai/v1";

// Default catalog — the endpoint's live /models refresh overwrites this
// whenever a key is present. These are the stable gateway slugs.
const MODELS: ModelCatalog = {
  default: "orcarouter/fusion",
  options: [
    { id: "orcarouter/fusion", label: "OrcaRouter Fusion" },
    { id: "orcarouter/fusion-flash", label: "OrcaRouter Fusion Flash" },
    { id: "orcarouter/fusion-mini", label: "OrcaRouter Fusion Mini" },
    { id: "orcarouter/free", label: "OrcaRouter Free" },
  ],
};

export interface OrcaRouterConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
}

const driverConfigSchema = z.object({
  url: z.string().optional(),
});

function normalizedApiUrl(value: string): string {
  const root = value.trim().replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

export function decodeOrcaRouterConfig(raw: unknown): OrcaRouterConfig {
  // Decode is the I/O boundary: invalid config throws (registry downgrades
  // it to an unavailable shadow), never silently falls back.
  const { url } = driverConfigSchema.parse(raw ?? {});
  const envUrl = process.env.ORCAROUTER_BASE_URL?.trim();
  return {
    url: normalizedApiUrl(url?.trim() || envUrl || DEFAULT_URL),
  };
}

export const OrcaRouterDriver: ProviderDriver<OrcaRouterConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OrcaRouter (AI gateway)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: MODELS,
  install: {
    docsUrl: "https://www.orcarouter.ai",
    command: {
      darwin:
        "Get a free key at https://www.orcarouter.ai then add it to ~/.openmausbot/config.json under orcarouter.key (or set ORCAROUTER_API_KEY)",
      linux:
        "Get a free key at https://www.orcarouter.ai then add it to ~/.openmausbot/config.json under orcarouter.key (or set ORCAROUTER_API_KEY)",
      win32:
        "Get a free key at https://www.orcarouter.ai then add it to %USERPROFILE%\\.openmausbot\\config.json under orcarouter.key (or set ORCAROUTER_API_KEY)",
    },
    signInCommand: "add {\"orcarouter\":{\"key\":\"…\"}} to ~/.openmausbot/config.json (or set ORCAROUTER_API_KEY)",
  },
  decodeConfig: decodeOrcaRouterConfig,
  defaultConfig: () => decodeOrcaRouterConfig({}),

  async create(input: DriverCreateInput<OrcaRouterConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey =
      input.environment[API_KEY_ENV]?.trim() ||
      input.environment["ORCAROUTER_API_KEY"]?.trim() ||
      process.env[API_KEY_ENV]?.trim() ||
      process.env["ORCAROUTER_API_KEY"]?.trim() ||
      "";

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    let catalog: ModelCatalog = MODELS;

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
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void },
    ): Promise<{ text: string; reasoning: string; usage: { input: number; output: number } | null }> => {
      const timeout = AbortSignal.timeout(180_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: opts.stream,
          stream_options: opts.stream ? { include_usage: true } : undefined,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OrcaRouter HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        const mainContent = typeof msg?.content === "string" ? msg.content : "";
        const reasoningContent = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
        return {
          text: mainContent,
          reasoning: reasoningContent,
          usage: json.usage
            ? {
                input: json.usage.prompt_tokens ?? 0,
                output: json.usage.completion_tokens ?? 0,
              }
            : null,
        };
      }

      let text = "";
      let reasoning = "";
      let usage: { input: number; output: number } | null = null;
      if (!res.body) throw new Error("OrcaRouter returned no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
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
            const delta = chunk.choices?.[0]?.delta;
            const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
            const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
            if (reasoningDelta) {
              reasoning += reasoningDelta;
              opts.onDelta?.(reasoningDelta, "reasoning_text");
            }
            if (contentDelta) {
              text += contentDelta;
              opts.onDelta?.(contentDelta, "assistant_text");
            }
            if (chunk.usage) {
              usage = {
                input: chunk.usage.prompt_tokens ?? 0,
                output: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return { text, reasoning, usage };
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
          const label = typeof row.name === "string" && row.name.trim() ? row.name : id;
          options.push({ id, label });
        }
        if (options.length) {
          catalog = {
            default: options.some((o) => o.id === MODELS.default) ? MODELS.default : options[0]?.id ?? MODELS.default,
            options,
          };
        }
      } catch {
        // keep MODELS — never fail the instance on a catalog miss
      }
    };
    if (apiKey) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) {
        throw new Error(`no OrcaRouter key — set ${API_KEY_ENV} or add it to the instance config`);
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
        source: "orcarouter.chat.completions",
        msg: { model: turn.model ?? catalog.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? catalog.default });

      (async () => {
        try {
          const { text, reasoning, usage } = await complete(messages, turn.model || catalog.default, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta, streamKind = "assistant_text") =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta }),
          });

          appendNative(threadId, {
            dir: "in",
            source: "orcarouter.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, usage },
          });

          const replyText = text.trim() ? text : reasoning;
          if (replyText.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: replyText });
          }
          if (usage) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          active.delete(threadId);
          const completed: RuntimeEvent = {
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
          };
          emit(usage ? { ...completed, usage } : completed);
        } catch (e) {
          active.delete(threadId);
          const error = e instanceof Error ? e : new Error(String(e));
          const aborted = error.name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message });
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
          reason: `no OrcaRouter key — set ${API_KEY_ENV} or add it to the instance config`,
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
        respondToRequest: async (): Promise<"unavailable"> => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const { abort } of active.values()) abort.abort(); },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete([{ role: "user", content: prompt }], catalog.default, { stream: false });
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
