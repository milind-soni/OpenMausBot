import { newEventId, newId } from "../contracts.js";
import { appendNative } from "./native.js";
const DRIVER_KIND = "boxAgent";
const BOX_API = "https://ascii.dev/api/box/v1";
const MODELS = {
    default: "sonnet",
    options: [
        { id: "sonnet", label: "Claude Sonnet · on the box (provider alias)" },
    ],
};
const providerFor = (model) => (model.startsWith("gpt") ? "codex" : "claude-code");
function decodeConfig(raw) {
    const o = (raw ?? {});
    return { pollMs: typeof o.pollMs === "number" ? o.pollMs : 2500 };
}
export const BoxAgentDriver = {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Computer", supportsMultipleInstances: false },
    models: MODELS,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    async create(input) {
        const { instanceId, config } = input;
        const token = input.environment.BOX_TOKEN ?? process.env.BOX_TOKEN ?? "";
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
        const api = async (path, opts = {}) => {
            const res = await fetch(`${BOX_API}${path}`, {
                ...opts,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers ?? {}) },
                signal: opts.signal ?? AbortSignal.timeout(30_000),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok || body?.ok === false) {
                throw new Error(body?.code ?? body?.error ?? `box HTTP ${res.status}`);
            }
            return body;
        };
        const sendTurn = async (turn) => {
            const { threadId } = turn;
            const boxId = turn.integrations?.computer?.boxId;
            if (!token)
                throw new Error('box not configured — add {"box":{"token":"…"}} to ~/.gbs/config.json');
            if (!boxId)
                throw new Error("this bot has no computer yet — open the Computer panel and provision one");
            if (active.has(threadId))
                throw new Error("a turn is already running on this thread");
            const turnId = newId();
            const model = turn.model || MODELS.default;
            const prompt = [
                turn.system,
                "You are working on your own cloud computer — its desktop, Chrome, and shell are yours.",
                "",
                turn.text,
            ]
                .filter((s) => s !== undefined)
                .join("\n");
            const started = await api(`/boxes/${boxId}/prompt`, {
                method: "POST",
                body: JSON.stringify({ provider: providerFor(model), model, prompt }),
            });
            appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt, response: started } });
            // real shape (2026-08): {type:"prompt.queued", promptId, promptRun:{id,…},
            // id:<box id>} — never fall back to the bare id, it's the box's
            const promptId = started?.promptRun?.id ?? started?.prompt?.id ?? started?.promptId ?? null;
            let cancelled = false;
            active.set(threadId, {
                turnId,
                boxId,
                cancel: () => {
                    cancelled = true;
                    void api(`/boxes/${boxId}/interrupt`, { method: "POST" }).catch(() => { });
                },
            });
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });
            // poll events + run status until the prompt settles
            (async () => {
                const seen = new Set();
                const startedAt = Date.now();
                let lastText = "";
                try {
                    for (;;) {
                        if (cancelled)
                            break;
                        await new Promise((r) => setTimeout(r, config.pollMs));
                        const events = await api(`/boxes/${boxId}/events`).catch(() => null);
                        const list = events?.events ?? events?.items ?? [];
                        for (const ev of list) {
                            const id = String(ev.id ?? ev.eventId ?? JSON.stringify(ev).slice(0, 120));
                            if (seen.has(id))
                                continue;
                            seen.add(id);
                            appendNative(threadId, { dir: "in", source: "box.events", msg: ev });
                            const kind = String(ev.type ?? ev.kind ?? "");
                            // "response" events carry the agent's text at data.content
                            const text = ev.text ?? ev.message ?? ev.data?.text ?? ev.data?.content ?? null;
                            if (/assistant|message|output|response/i.test(kind) && typeof text === "string" && text.trim()) {
                                lastText = text;
                                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
                            }
                            else if (/tool|command|exec|browse/i.test(kind)) {
                                emit({
                                    ...base(threadId, turnId),
                                    type: "item.started",
                                    itemType: "tool",
                                    itemId: id,
                                    title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                                });
                            }
                        }
                        if (promptId) {
                            const status = await api(`/boxes/${boxId}/prompts/${promptId}`).catch(() => null);
                            appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
                            // real shape (2026-08): {promptRun:{status:"finished",…}} —
                            // flat fallbacks kept for drift
                            const run = status?.promptRun ?? status?.prompt ?? status ?? {};
                            const state = String(run?.status ?? "");
                            if (/completed|succeeded|done|finished/i.test(state)) {
                                const result = run?.result ?? run?.output ?? lastText;
                                if (typeof result === "string" && result.trim() && result !== lastText) {
                                    emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: result });
                                }
                                emit({
                                    ...base(threadId, turnId),
                                    type: "item.completed",
                                    itemType: "assistant_text",
                                    text: typeof result === "string" && result.trim() ? result : lastText || "(finished)",
                                });
                                active.delete(threadId);
                                emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                                return;
                            }
                            if (/failed|error|cancelled|interrupted/i.test(state)) {
                                if (lastText) {
                                    emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: lastText });
                                }
                                active.delete(threadId);
                                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: state, cost: null });
                                return;
                            }
                        }
                        if (Date.now() - startedAt > 30 * 60_000) {
                            throw new Error("box run exceeded 30 minutes — interrupted");
                        }
                    }
                    // cancelled
                    active.delete(threadId);
                    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
                }
                catch (e) {
                    active.delete(threadId);
                    emit({ ...base(threadId, turnId), type: "runtime.error", message: e.message });
                    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
                }
            })();
            return { turnId };
        };
        const snapshot = async () => {
            if (!token) {
                return { state: "unavailable", reason: 'no Box token — add {"box":{"token":"…"}} to ~/.gbs/config.json' };
            }
            try {
                await api("/me");
                return { state: "available", authenticated: true, version: null };
            }
            catch (e) {
                return { state: "unavailable", reason: `box API unreachable: ${e.message}` };
            }
        };
        return {
            instanceId,
            driverKind: DRIVER_KIND,
            displayName: input.displayName,
            enabled: input.enabled,
            models: MODELS,
            snapshot,
            adapter: {
                provider: DRIVER_KIND,
                capabilities: { sessionModelSwitch: "in-session" },
                sendTurn,
                interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
                respondToRequest: async () => {
                    throw new Error("box agent asks are not wired yet");
                },
                hasSession: (threadId) => active.has(threadId),
                stopAll: async () => {
                    for (const { cancel } of active.values())
                        cancel();
                },
                onEvent: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            dispose: async () => {
                for (const { cancel } of active.values())
                    cancel();
                listeners.clear();
            },
        };
    },
};
