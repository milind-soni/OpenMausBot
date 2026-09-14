// The local RLM harness as a Vision engine model route: `rlm:*` models run
// the recursive reasoning loop (server/rlm.ts) over the same freellmapi
// endpoint this instance is already pointed at — no separate proxy, no new
// credentials. `rlm:auto` picks a small cheap helper as the root (the paper's
// setting: a small model doing far larger work than its parameters suggest);
// `rlm:<model>` routes the root at that explicit model with `auto` helpers.
import type {
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { rlmRootSystem, rlmSubSystem, runRlmTurn } from "../rlm.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "vision";

/** Cheap, everywhere-available defaults for the harness's helper calls. */
export const RLM_HELPER_CANDIDATES = ["direct:deepseek-chat", "openrouter:meta-llama/llama-3.3-70b-instruct", "auto"];

export function rlmRootModelFor(catalog: ModelCatalog): string {
  if (catalog.default && catalog.default.startsWith("rlm:")) {
    return catalog.default.slice("rlm:".length) || "auto";
  }
  for (const helper of RLM_HELPER_CANDIDATES) {
    if (helper === "auto" || catalog.options.some((option) => option.id === helper)) return helper;
  }
  return "auto";
}

export function rlmHelperModel(catalog: ModelCatalog): string {
  for (const helper of RLM_HELPER_CANDIDATES) {
    if (helper === "auto" || catalog.options.some((option) => option.id === helper)) return helper;
  }
  return "auto";
}

// ── upstream chat plumbing ──────────────────────────────────────────────
interface Completion {
  text: string;
  usage: { input: number; output: number } | null;
}

interface CompletionJson {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const usageFrom = (usage: CompletionJson["usage"]) =>
  usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } : null;

async function chatCompletion(
  endpoint: { url: string; apiKey: string },
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Completion> {
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(`${endpoint.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`upstream HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const json = (await response.json()) as CompletionJson;
  const message = json.choices?.[0]?.message;
  return {
    text: typeof message?.content === "string" ? message.content : "",
    usage: usageFrom(json.usage),
  };
}

// ── driver ──────────────────────────────────────────────────────────────
export interface RlmRouteInput {
  instanceId: string;
  displayName: string | undefined;
  endpoint: { url: string; apiKey: string };
  model: string;
}

/** Build a ProviderInstance whose `rlm:<model>` catalog entry runs the
 * local RLM loop. Everything else (catalog, lifecycle) is inherited from
 * the shared Vision driver instance via `inherit`. */
export function createRlmRouteInstance(input: RlmRouteInput, inherit: ProviderInstance): ProviderInstance {
  const rlmOptionId = `rlm:${input.model}`;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, AbortController>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };

  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: DRIVER_KIND,
    providerInstanceId: input.instanceId,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
    raw: { source: "vision.rlm", payload: null },
  });

  const sendTurn = async (turn: SendTurnInput) => {
    // Model routing: only `rlm:<model>` runs the local harness. Everything
    // else — plain chat models, direct:*, freellm/* — is delegated verbatim
    // to the shared runtime this route was composed over.
    const isRlm = !turn.model || turn.model.startsWith("rlm:");
    if (!isRlm) return inherit.adapter.sendTurn(turn);

    if (!input.endpoint.apiKey) {
      emit({ ...base(turn.threadId, newId()), type: "runtime.error", message: "no API key for the RLM harness" });
      throw new Error("no API key for the RLM harness");
    }
    if (active.has(turn.threadId) || inherit.adapter.hasSession(turn.threadId)) {
      throw new Error("a turn is already running on this thread");
    }
    // An explicit per-turn `rlm:<model>` names the root; `rlm:auto` (or no
    // model) falls back to the route's default root.
    const rootModel = turn.model && turn.model.length > "rlm:".length ? turn.model.slice("rlm:".length) : input.model;

    // Ownership edge: this wrapper inherits apiToolLoop from the Vision
    // runtime it wraps, so startTurn hands it a tool toolbox for harness
    // turns too — but the RLM loop is pure text reasoning over its sandbox
    // and has no tool consumer yet. Closing immediately keeps the mounted
    // MCP servers from leaking past the turn; a future harness-tool
    // integration is where this becomes a pass-through instead of a close.
    void turn.tools?.close().catch(() => {});

    const turnId = newId();
    const abort = new AbortController();
    active.set(turn.threadId, abort);
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? rlmOptionId });

    void (async () => {
      let itemId = 0;
      let lastError: string | null = null;
      try {
        const result = await runRlmTurn(
          {
            system: turn.system,
            transcript: turn.transcript ?? [],
            prompt: turn.text,
            signal: abort.signal,
          },
          {
            chat: async (request) => {
              const model = request.kind === "root" ? rootModel : rlmHelperModel(inherit.models);
              const system = request.kind === "root" ? rlmRootSystem(request.system) : rlmSubSystem(request.system);
              const completion = await chatCompletion(
                input.endpoint,
                {
                  model,
                  messages: [{ role: "system", content: system }, ...request.messages.map((m) => ({ role: m.role, content: m.content }))],
                  stream: false,
                },
                request.signal,
              );
              appendNative(turn.threadId, {
                dir: "in",
                source: "vision.rlm",
                msg: { kind: request.kind, model, textLength: completion.text.length, usage: completion.usage },
              });
              return { text: completion.text, usage: completion.usage ?? { input: 0, output: 0 } };
            },
            emit: (event) => {
              if (event.kind === "reasoning") {
                emit({ ...base(turn.threadId, turnId), itemId: `${turnId}:${itemId++}`, type: "content.delta", streamKind: "reasoning_text", delta: event.delta });
              } else if (event.kind === "tool") {
                emit({ ...base(turn.threadId, turnId), itemId: `${turnId}:${itemId++}`, type: "item.started", itemType: "tool", title: event.title, summary: event.detail });
                emit({ ...base(turn.threadId, turnId), itemId: `${turnId}:${itemId - 1}`, type: "item.completed", itemType: "tool", ok: true });
              } else if (event.kind === "retry") {
                emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: event.attempt, delayMs: event.delayMs, reason: event.reason });
              }
            },
          },
        );

        const text = result.text.trim();
        if (text) {
          emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        } else {
          lastError = "the RLM harness produced no answer";
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: lastError });
        }
        emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", input: result.usage.input, output: result.usage.output });
        active.delete(turn.threadId);
        emit({
          ...base(turn.threadId, turnId),
          type: "turn.completed",
          ok: !lastError,
          stopReason: lastError ? "error" : null,
          cost: null,
          usage: result.usage,
        });
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        const aborted = error.name === "AbortError" || abort.signal.aborted;
        active.delete(turn.threadId);
        if (!aborted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error.message });
        emit({
          ...base(turn.threadId, turnId),
          type: "turn.completed",
          ok: false,
          stopReason: aborted ? "interrupted" : "error",
          cost: null,
        });
      } finally {
        active.delete(turn.threadId);
      }
    })();
    return { turnId };
  };

  return {
    ...inherit,
    instanceId: input.instanceId,
    displayName: input.displayName ?? inherit.displayName,
    // Object spread would snapshot the base's catalog getter; keep it live
    // so helper-model selection tracks refreshed catalogs.
    get models() {
      return inherit.models;
    },
    adapter: {
      ...inherit.adapter,
      provider: DRIVER_KIND,
      sendTurn,
      interruptTurn: async (threadId) => {
        active.get(threadId)?.abort();
        // A delegated (non-rlm) turn is owned by the base runtime.
        await inherit.adapter.interruptTurn(threadId);
      },
      hasSession: (threadId) => active.has(threadId) || inherit.adapter.hasSession(threadId),
      stopAll: async () => {
        for (const abort of active.values()) abort.abort();
        await inherit.adapter.stopAll();
      },
      // Fan-in: harness events here, delegated-turn events from the base.
      onEvent: (listener) => {
        listeners.add(listener);
        const offBase = inherit.adapter.onEvent(listener);
        return () => {
          listeners.delete(listener);
          offBase();
        };
      },
    },
  };
}

