import { newEventId, newId } from "../contracts.js";
import { appendNative } from "./native.js";
import { catalog } from "../model-discovery.js";
const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
const MODELS = {
    default: "grok-4",
    options: [
        { id: "grok-4", label: "Grok 4" },
        { id: "grok-4-fast", label: "Grok 4 Fast" },
        { id: "grok-3-mini", label: "Grok 3 Mini" },
    ],
};
function decodeConfig(raw) {
    const o = (raw ?? {});
    return {
        url: typeof o.url === "string" ? o.url : DEFAULT_URL,
        apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "XAI_API_KEY",
    };
}
export const GrokDriver = {
    driverKind: DRIVER_KIND,
    // "(API)" distinguishes this key-billed driver from grokAgent, the CLI one
    metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
    models: MODELS,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    async create(input) {
        const { instanceId, config } = input;
        const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
        const listeners = new Set();
        const active = new Map();
        const emit = (event) => {
            for (const l of [...listeners])
                l(event);
        };
        const base = (threadId, turnId) => ({
            eventId: newEventId(),
            provider: DRIVER_KIND,
            threadId,
            turnId,
            createdAt: new Date().toISOString(),
        });
        const complete = async (messages, model, opts) => {
            const res = await fetch(`${config.url}/chat/completions`, {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({ model, messages, stream: opts.stream }),
                signal: opts.signal ?? AbortSignal.timeout(120_000),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`xAI HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
            }
            if (!opts.stream) {
                const json = await res.json();
                return {
                    text: json.choices?.[0]?.message?.content ?? "",
                    usage: json.usage
                        ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
                        : null,
                };
            }
            let text = "";
            let usage = null;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith("data:"))
                        continue;
                    const data = line.slice(5).trim();
                    if (data === "[DONE]")
                        continue;
                    let chunk;
                    try {
                        chunk = JSON.parse(data);
                    }
                    catch {
                        continue;
                    }
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                        text += delta;
                        opts.onDelta?.(delta);
                    }
                    if (chunk.usage) {
                        usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
                    }
                }
            }
            return { text, usage };
        };
        const sendTurn = async (turn) => {
            const { threadId } = turn;
            if (!apiKey)
                throw new Error(`no xAI key — set ${config.apiKeyEnv} or config.json xai.key`);
            if (active.has(threadId))
                throw new Error("a turn is already running on this thread");
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
            appendNative(threadId, { dir: "out", source: "xai.chat.completions", msg: { model: turn.model, messages } });
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });
            (async () => {
                try {
                    const { text, usage } = await complete(messages, turn.model || MODELS.default, {
                        stream: true,
                        signal: abort.signal,
                        onDelta: (delta) => emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
                    });
                    appendNative(threadId, { dir: "in", source: "xai.chat.completions", msg: { text, usage } });
                    if (text.trim()) {
                        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
                    }
                    if (usage) {
                        emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
                    }
                    active.delete(threadId);
                    emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                }
                catch (e) {
                    active.delete(threadId);
                    const aborted = e.name === "AbortError";
                    if (!aborted) {
                        emit({ ...base(threadId, turnId), type: "runtime.error", message: e.message });
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
        const snapshot = async () => {
            if (!apiKey) {
                return {
                    state: "unavailable",
                    reason: `no xAI API key — add {"xai":{"key":"xai-…"}} to ~/.gbs/config.json or set ${config.apiKeyEnv}`,
                };
            }
            return { state: "available", authenticated: true, version: null };
        };
        return {
            instanceId,
            driverKind: DRIVER_KIND,
            displayName: input.displayName,
            enabled: input.enabled,
            models: MODELS,
            discoverModels: async () => {
                if (!apiKey)
                    throw new Error("xAI API key is not configured");
                const response = await fetch(`${config.url}/language-models`, {
                    headers: { authorization: `Bearer ${apiKey}` },
                    signal: AbortSignal.timeout(12_000),
                });
                if (!response.ok)
                    throw new Error(`xAI model discovery HTTP ${response.status}`);
                const payload = await response.json();
                return catalog((Array.isArray(payload.models) ? payload.models : []).filter((m) => typeof m.id === "string" && (!Array.isArray(m.output_modalities) || m.output_modalities.includes("text"))).map((m) => ({ id: m.id, label: m.id })));
            },
            snapshot,
            adapter: {
                provider: DRIVER_KIND,
                capabilities: { sessionModelSwitch: "in-session" },
                sendTurn,
                interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
                respondToRequest: async () => {
                    throw new Error("grok driver has no pending asks");
                },
                hasSession: (threadId) => active.has(threadId),
                stopAll: async () => {
                    for (const { abort } of active.values())
                        abort.abort();
                },
                onEvent: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            generateText: async (prompt) => {
                const { text } = await complete([{ role: "user", content: prompt }], "grok-3-mini", { stream: false });
                return text;
            },
            dispose: async () => {
                for (const { abort } of active.values())
                    abort.abort();
                listeners.clear();
            },
        };
    },
};
