// The Pi-backed implementation of OwnedAgentRuntime.
//
// This is the ONLY production file that imports @earendil-works/pi-*. It
// owns three things: turning a TurnContextPlan into the messages Pi will
// send, running Pi's agent loop under OpenMausBot's bounds, and translating
// Pi's events into the runtime's own union. Everything else — dispatch, the
// driver, the event bus — sees only server/runtime/contracts.ts.
//
// Two rules are load-bearing here:
//
// - The model's view is rebuilt from the canonical plan before every model
//   call. Pi keeps a live transcript inside the Agent, but that transcript is
//   seeded from the plan at turn start and only THIS turn's tool-call/result
//   pairs are appended to it. Nothing survives the turn; the next turn's
//   plan is the only history.
// - The API key is passed explicitly on every call and Pi is given an empty
//   provider env, so it can never fall back to reading a key from the
//   process environment or a credential store it happens to know about.
import { Agent, type AgentEvent, type AgentTool, type AgentToolResult, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Api, type Context, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
// The provider subpath, not /compat: compat re-exports every provider pi
// ships (Anthropic, Bedrock, Google, Mistral, Azure, …) and esbuild inlines
// all of it into the packaged server. This engine speaks exactly one wire
// protocol, so it imports exactly one.
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

import type { EffortLevel } from "../contracts.ts";
import { sanitizeToolObservation } from "../context/sanitize.ts";
import type { ModelContextItem } from "../context/types.ts";
import { renderToolChip } from "../context/project.ts";
import { createApprovalGate, type ApprovalGate } from "./approval-gate.ts";
import type { OwnedAgentRuntime, OwnedModelTarget, OwnedTool } from "./contracts.ts";
import { REPEAT_ADVISORY_NOTE, REPEAT_STOP_NOTE, createLoopGuard } from "./loop-guard.ts";

/** What a Pi model call is made with. Exported so the driver can pass a
 * fake in tests and so nothing else needs to spell Pi's signature. */
export type PiStreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/** Text summaries a model is handed for a tool result are bounded here,
 * separately from the smaller durable ToolContextSnapshot: the model can
 * usefully read more than the transcript should keep forever. */
const MODEL_VISIBLE_RESULT_LIMIT = 24_000;

const OPENROUTER_HOSTS = new Set(["openrouter.ai"]);

function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return OPENROUTER_HOSTS.has(host) || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** The plan's provider-neutral items, as Pi messages. Portable tool
 * observations become descriptive assistant text — never fabricated Pi
 * tool-call/result pairs with invented ids, which a provider could reject or
 * misattribute. */
export function toPiMessages(items: readonly ModelContextItem[]): Message[] {
  const at = Date.now();
  const messages: Message[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user-text":
        messages.push({ role: "user", content: item.text, timestamp: at });
        break;
      case "assistant-text":
      case "summary":
      case "tool-observation": {
        const text = item.kind === "assistant-text"
          ? item.speaker ? `${item.speaker}: ${item.text}` : item.text
          : item.kind === "summary"
            ? `[Summary of the earlier conversation]\n${item.text}`
            : renderToolChip(item.observation);
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: "openmaus",
          model: "history",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: at,
        });
        break;
      }
    }
  }
  return messages;
}

export function toPiModel(target: OwnedModelTarget): Model<"openai-completions"> {
  const openRouter = isOpenRouter(target.baseUrl);
  return {
    id: target.id,
    name: target.id,
    api: "openai-completions",
    provider: openRouter ? "openrouter" : "openmaus",
    baseUrl: target.baseUrl,
    reasoning: target.reasoning,
    input: ["text"],
    // metered cost is reported by the provider in usage; nothing is
    // estimated here
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: target.contextWindow,
    maxTokens: target.maxOutputTokens,
    ...(openRouter && target.openRouterProvider
      ? { compat: { openRouterRouting: { order: [target.openRouterProvider], allow_fallbacks: false } } }
      : {}),
  };
}

function thinkingLevel(effort: EffortLevel | undefined, reasoning: boolean): ThinkingLevel | undefined {
  if (!reasoning || !effort) return undefined;
  return effort === "none" ? "off" : effort;
}

function toPiTool(tool: OwnedTool, timeoutMs: number): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    async execute(toolCallId, params, signal): Promise<AgentToolResult<{ ok: boolean }>> {
      // A tool that never returns must not hold the turn forever; the
      // turn-level watchdog upstream wins if it fires first.
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await tool.execute(toolCallId, args, combined);
      const text = result.text.length > MODEL_VISIBLE_RESULT_LIMIT
        ? `${result.text.slice(0, MODEL_VISIBLE_RESULT_LIMIT)}\n[truncated]`
        : result.text;
      return { content: [{ type: "text", text }], details: { ok: result.ok } };
    },
  };
}

interface LiveTurn {
  agent: Agent;
  abort: AbortController;
  gate: ApprovalGate;
}

export function createPiRuntime(options: { streamFn?: PiStreamFn; askTimeoutMs?: number } = {}): OwnedAgentRuntime {
  const live = new Map<string, LiveTurn>();
  // streamSimple maps the thinking level onto provider-specific fields and
  // takes the same options shape the Agent hands us
  const streamFn: PiStreamFn = options.streamFn ?? ((model, context, opts) => {
    // the Agent's contract is Model<Api>; this runtime only ever builds one
    // api, so the narrowing is a fact about toPiModel, not a hope
    if (model.api !== "openai-completions") throw new Error(`openmaus-runtime speaks openai-completions, not ${model.api}`);
    return streamSimple(model as Model<"openai-completions">, context, opts);
  });

  const run: OwnedAgentRuntime["run"] = async (input, emit) => {
    if (live.has(input.threadId)) throw new Error("a turn is already running on this thread");
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort();
    input.signal.addEventListener("abort", onOuterAbort, { once: true });

    const model = toPiModel(input.model);
    let modelCalls = 0;
    let toolCalls = 0;
    // Every tool call asks. Auto-approval is the harness's decision, made
    // on the request.opened event; from here it is just an answer that
    // arrived. Nothing runs on silence.
    const gate = createApprovalGate({
      onOpen: (ask) => emit({ type: "ask.opened", requestId: ask.id, kind: ask.kind, tool: ask.tool, summary: ask.summary, ...(ask.choices ? { choices: ask.choices } : {}) }),
      onResolve: (ask, r) => emit({ type: "ask.resolved", requestId: ask.id, behavior: r.behavior, source: r.source }),
      ...(options.askTimeoutMs === undefined ? {} : { timeoutMs: options.askTimeoutMs }),
    });
    const guard = createLoopGuard();
    const advisories = new Set<string>();
    let stopReason: "end_turn" | "max_model_calls" | "max_tool_calls" = "end_turn";
    let failed: string | null = null;
    let finalText = "";
    const observations = new Map<string, { name: string; inputSummary: string }>();

    const agent = new Agent({
      initialState: {
        systemPrompt: input.system ?? "",
        model,
        thinkingLevel: thinkingLevel(input.effort, input.model.reasoning) ?? "off",
        // the canonical plan IS the history; nothing else is carried in
        messages: toPiMessages(input.plan.messages),
        tools: input.tools.map((tool) => toPiTool(tool, input.limits.toolTimeoutMs)),
      },
      // the key rides on every request explicitly; an empty env means Pi has
      // nowhere else to look
      streamFn: (m, context, opts) => {
        modelCalls += 1;
        emit({ type: "model.call", call: modelCalls });
        return streamFn(m, context, { ...opts, apiKey: input.model.apiKey, env: {}, signal: abort.signal });
      },
      convertToLlm: (messages) => messages as Message[],
      beforeToolCall: async (context) => {
        toolCalls += 1;
        if (toolCalls > input.limits.maxToolCalls) {
          stopReason = "max_tool_calls";
          return { block: true, reason: `tool call limit of ${input.limits.maxToolCalls} reached`, terminate: true };
        }
        const verdict = guard.observe(context.toolCall.name, context.args);
        if (verdict === "stop") {
          stopReason = "max_tool_calls";
          return { block: true, reason: REPEAT_STOP_NOTE, terminate: true };
        }
        if (verdict === "advisory") advisories.add(context.toolCall.id);
        const summary = JSON.stringify(context.args ?? {}).slice(0, 300);
        const answer = await gate.ask({ kind: "permission", tool: context.toolCall.name, summary });
        if (answer.behavior !== "allow") {
          return { block: true, reason: answer.message ?? "OpenMausBot: this action was not approved." };
        }
        return undefined;
      },
      afterToolCall: async (context) => {
        if (!advisories.delete(context.toolCall.id)) return undefined;
        // the model is told, in the result it is about to read, that it is
        // repeating itself — most models take the hint before the stop
        const content = Array.isArray(context.result?.content) ? context.result.content : [];
        return { content: [...content, { type: "text", text: REPEAT_ADVISORY_NOTE }] };
      },
      shouldStopAfterTurn: () => {
        if (modelCalls >= input.limits.maxModelCalls) {
          stopReason = "max_model_calls";
          return true;
        }
        return false;
      },
    });

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") emit({ type: "delta", kind: "text", text: e.delta });
          else if (e.type === "thinking_delta") emit({ type: "delta", kind: "reasoning", text: e.delta });
          else if (e.type === "error") failed = e.error.errorMessage ?? "model error";
          return;
        }
        case "message_end": {
          const message = event.message;
          if (message.role !== "assistant") return;
          const text = message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (message.stopReason === "error") failed = message.errorMessage ?? "model error";
          if (text.trim()) finalText = text;
          if (message.usage.totalTokens > 0) {
            emit({
              type: "usage",
              input: message.usage.input,
              output: message.usage.output,
              ...(message.usage.cacheRead ? { cachedInput: message.usage.cacheRead } : {}),
              ...(message.usage.cost.total ? { costUsd: message.usage.cost.total } : {}),
            });
          }
          return;
        }
        case "tool_execution_start": {
          const inputSummary = JSON.stringify(event.args ?? {});
          observations.set(event.toolCallId, { name: event.toolName, inputSummary });
          emit({ type: "tool.started", callId: event.toolCallId, name: event.toolName, inputSummary });
          return;
        }
        case "tool_execution_end": {
          const started = observations.get(event.toolCallId);
          const output = typeof event.result === "string"
            ? event.result
            : Array.isArray(event.result?.content)
              ? event.result.content.map((c: { text?: string }) => c.text ?? "").join("")
              : "";
          // the durable record is bounded and redacted here, once, so no
          // caller can persist a raw result by accident
          const observation = sanitizeToolObservation({
            callId: event.toolCallId,
            name: event.toolName,
            input: started?.inputSummary,
            output,
            ok: !event.isError,
          });
          emit({ type: "tool.completed", callId: event.toolCallId, name: event.toolName, ok: !event.isError, observation });
          return;
        }
        default:
          return;
      }
    });

    live.set(input.threadId, { agent, abort, gate });
    try {
      await agent.prompt(input.plan.currentPrompt);
      if (!failed && agent.state.errorMessage && !abort.signal.aborted) failed = agent.state.errorMessage;
      if (failed) {
        emit({ type: "error", message: failed });
        emit({ type: "completed", ok: false, stopReason: "error" });
      } else if (abort.signal.aborted) {
        emit({ type: "completed", ok: false, stopReason: "interrupted" });
      } else {
        if (finalText.trim()) emit({ type: "assistant", text: finalText });
        emit({ type: "completed", ok: true, stopReason });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        emit({ type: "completed", ok: false, stopReason: "interrupted" });
      } else {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        emit({ type: "completed", ok: false, stopReason: "error" });
      }
    } finally {
      // an ask that outlives the turn is answered by the system, never left
      // hanging for a tool that will never run
      gate.drain();
      unsubscribe();
      input.signal.removeEventListener("abort", onOuterAbort);
      live.delete(input.threadId);
    }
  };

  return {
    run,
    steer: (threadId, text) => {
      const turn = live.get(threadId);
      if (!turn) return false;
      turn.agent.steer({ role: "user", content: text, timestamp: Date.now() });
      return true;
    },
    interrupt: (threadId) => {
      const turn = live.get(threadId);
      if (!turn) return;
      turn.gate.drain();
      turn.abort.abort();
      turn.agent.abort();
    },
    answer: (threadId, requestId, behavior, message) => {
      const turn = live.get(threadId);
      // no live turn means no pending ask: unavailable, which the harness
      // treats as a deny and never as an allow
      if (!turn) return "unavailable";
      return turn.gate.answer(requestId, behavior, message);
    },
    hasTurn: (threadId) => live.has(threadId),
    dispose: async () => {
      for (const turn of live.values()) {
        turn.gate.drain();
        turn.abort.abort();
        turn.agent.abort();
      }
      live.clear();
    },
  };
}
