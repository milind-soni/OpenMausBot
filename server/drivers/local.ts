// Direct local OpenAI-compatible driver. The model catalog is projected by
// the guarded fleet registry; this transport only talks to the one configured
// host after the user selects a row. It never scans other providers.
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
import { z } from "zod";
import { hostApiKey, LOCAL_HOSTS, type LocalHost } from "./local-inject.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "local";
// A configured local endpoint should answer on LAN/loopback promptly. Keep
// startup and explicit refresh bounded even when the host is asleep; catalog
// admission remains the authoritative longer-running health signal.
const PROBE_MS = 750;
const TURN_MS = 10 * 60_000;
const MODEL_ID = /^(?![\s\S]*[\r\n])[\w][\w./:+-]*$/;

export interface LocalConfig {
  host: string;
  url?: string;
  /** Which canonical direct-local selector this instance owns. */
  fleetHost?: "mac" | "windows";
}

interface LocalProbe {
  ok: boolean;
  reason?: string;
}

const localConfigSchema = z.object({
  host: z.string().min(1).default("ollama").refine(
    (value) => value === "custom" || LOCAL_HOSTS.some((host) => host.id === value),
    "unknown local host",
  ),
  url: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "local server url must be http(s)",
  }).optional(),
  fleetHost: z.enum(["mac", "windows"]).optional(),
});
const streamChunkSchema = z.looseObject({
  choices: z.array(z.looseObject({
    delta: z.looseObject({ content: z.string().optional() }),
  })).optional(),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
  }).nullable().optional(),
});

const CUSTOM: LocalHost = {
  id: "custom",
  label: "Local server",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: "local",
};

function hostFor(config: LocalConfig): LocalHost {
  const known = LOCAL_HOSTS.find((host) => host.id === config.host);
  const base = known ?? CUSTOM;
  return config.url ? { ...base, baseUrl: config.url.replace(/\/$/, "") } : base;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- ProviderDriver's opaque boundary is parsed immediately by the locked Zod schema.
function decodeConfig(raw: unknown): LocalConfig {
  const parsed = localConfigSchema.parse(raw ?? {});
  if (parsed.host === "custom" && !parsed.url) throw new Error("a custom local server needs a url");
  return parsed;
}

/** `translations.openmausbot` is stable across machines. The API host wants
 * only its native model id, and an instance must refuse the other machine's
 * selector rather than silently running a same-named model locally. */
export function decodeFleetLocalSelector(model: string, fleetHost?: "mac" | "windows"): string | null {
  const match = /^ollama-(mac|windows)\/(.+)$/.exec(model);
  if (!match) return MODEL_ID.test(model) ? model : null;
  if (!fleetHost || match[1] !== fleetHost || !MODEL_ID.test(match[2]!)) return null;
  return match[2]!;
}

const EMPTY: ModelCatalog = { default: "", options: [] };

export const LocalDriver: ProviderDriver<LocalConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Local models", supportsMultipleInstances: true, access: "custom" },
  models: EMPTY,
  install: {
    command: {
      darwin: "brew install ollama",
      linux: "curl -fsSL https://ollama.com/install.sh | sh",
    },
    docsUrl: "https://ollama.com/download",
    signInCommand: "ollama serve",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({ host: "ollama", fleetHost: "mac" }),

  async create(input: DriverCreateInput<LocalConfig>): Promise<ProviderInstance> {
    const host = hostFor(input.config);
    const environment = { ...process.env, ...input.environment };
    const headers = {
      authorization: `Bearer ${hostApiKey(host, environment)}`,
      "content-type": "application/json",
    };
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    let models: ModelCatalog = EMPTY;
    let lastProbe: LocalProbe = { ok: false, reason: "not probed yet" };

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    const probe = async (url: string): Promise<void> => {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    };

    const refreshModels = async () => {
      try {
        // Transport readiness only. Inventory and capability classification
        // come exclusively from the guarded fleet projection; copying a raw
        // /models response here would reintroduce unclassified or non-chat
        // rows as selectable UI options.
        await probe(`${host.baseUrl}/models`);
        models = EMPTY;
        lastProbe = { ok: true };
      } catch (error) {
        models = EMPTY;
        const detail = error instanceof Error ? error.message : String(error);
        lastProbe = {
          ok: false,
          reason: /ECONNREFUSED|fetch failed|timeout|Timeout/i.test(detail)
            ? `${host.label} is not running at ${host.baseUrl}`
            : `${host.label}: ${detail}`,
        };
      }
    };
    await refreshModels();

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      signal: AbortSignal,
      onDelta: (delta: string) => void,
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const response = await fetch(`${host.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TURN_MS)]),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${host.label} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`${host.label} returned no response body`);
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(data);
        } catch {
          return;
        }
        const parsed = streamChunkSchema.safeParse(decoded);
        if (!parsed.success) return;
        const chunk = parsed.data;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (chunk.usage) usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          consumeLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer) consumeLine(buffer);
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const selected = turn.model || models.default;
      const model = selected ? decodeFleetLocalSelector(selected, input.config.fleetHost) : null;
      if (!model) {
        throw new Error(selected
          ? `model selector "${selected}" does not belong to this ${input.config.fleetHost ?? "local"} host`
          : `no model to run — ${lastProbe.reason ?? "refresh the fleet catalog"}`);
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(turn.threadId, { abort, turnId });
      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((message) => ({ role: message.role, content: message.text })),
        { role: "user", content: turn.text },
      ];
      appendNative(turn.threadId, {
        dir: "out",
        source: "local.chat.completions",
        msg: { host: input.config.fleetHost ?? host.id, model, messages },
      });
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });
      void (async () => {
        try {
          const result = await complete(
            messages,
            model,
            abort.signal,
            (delta) => emit({
              ...base(turn.threadId, turnId),
              type: "content.delta",
              streamKind: "assistant_text",
              delta,
            }),
          );
          appendNative(turn.threadId, { dir: "in", source: "local.chat.completions", msg: result });
          if (result.text.trim()) emit({
            ...base(turn.threadId, turnId),
            type: "item.completed",
            itemType: "assistant_text",
            text: result.text,
          });
          if (result.usage) emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...result.usage });
          active.delete(turn.threadId);
          if (result.usage) {
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.completed",
              ok: true,
              stopReason: null,
              cost: null,
              usage: result.usage,
            });
          } else {
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.completed",
              ok: true,
              stopReason: null,
              cost: null,
            });
          }
        } catch (error) {
          active.delete(turn.threadId);
          const aborted = error instanceof Error && error.name === "AbortError";
          const message = error instanceof Error ? error.message : String(error);
          if (!aborted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message });
          emit({
            ...base(turn.threadId, turnId),
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
      // ProviderRegistry owns refresh policy. Re-probing here would make a
      // cached describe() perform network I/O anyway, and a live describe()
      // would probe this host twice.
      return lastProbe.ok
        ? { state: "available", authenticated: true, version: null }
        : { state: "unavailable", reason: lastProbe.reason };
    };

    return {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName ?? `${input.config.fleetHost === "windows" ? "Windows" : "Mac"} ${host.label}`,
      enabled: input.enabled,
      get models() { return models; },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          computerMcp: false,
          agentsMcp: false,
          composioMcp: false,
          queueing: false,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async (): Promise<"unavailable"> => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const entry of active.values()) entry.abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const entry of active.values()) entry.abort.abort();
        active.clear();
        listeners.clear();
      },
    };
  },
};
