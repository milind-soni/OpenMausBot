import type { DriverCreateInput, ModelCatalog, SendTurnInput, TextGenerationOptions } from "../contracts.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { rejectsKey, noteKeyRejected, noteKeyAccepted } from "../key-rejections.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Record<string, unknown>[];
}

export interface Usage {
  input: number;
  output: number;
}

export interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
}

interface CompletionJson {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

 function providerError(json: CompletionJson): string | null {
  if (typeof json.error === "string") return json.error;
  const error = object(json.error);
  if (error) return typeof error.message === "string" ? error.message : "unknown error";
  const code = json.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = typeof json.base_resp?.status_msg === "string" ? json.base_resp.status_msg : "";
    return `upstream error ${code}${msg ? `: ${msg}` : ""}`;
  }
  return null;
}

 const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

 function httpErrorDetail(body: string, limit = 500): string {
  let json: CompletionJson | undefined;
  try { json = object(JSON.parse(body)); } catch { json = undefined; }
  const message = json ? providerError(json) : null;
  if (!message || message === "unknown error") return body.slice(0, limit);
  const code = object(json?.error)?.code;
  const suffix = typeof code === "string" && MACHINE_CODE.test(code) ? ` (${code})` : "";
  return message.slice(0, limit) + suffix;
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

export interface RuntimeOptions<Config> {
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
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  tools?: boolean;
  computerUse?: boolean;
  imageInput?: (model: string) => boolean;
  nudgeAnnouncedAction?: boolean;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

export class UnsupportedChatToolsError extends Error {}

function rejectsToolsParameter(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const error = object(envelope?.error);
  if (error?.param === "tools" && error.code === "unsupported_parameter") return true;
  const message = error?.message ?? envelope?.error;
  return typeof message === "string" && (
    /\bdoes not support (?:tools|tool calling|function calling)(?:[.!]?$|[.!]?\s)/i.test(message) ||
    /\b(?:tools|tool calling|function calling) (?:is|are) not supported\b/i.test(message) ||
    /^(?:unsupported|unknown|unrecognized) (?:parameter|field):?\s*['"]?tools['"]?[.!]?$/i.test(message.trim())
  );
}

export class UnsupportedReasoningReplayError extends Error {}

 function rejectsReasoningReplay(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const message = object(envelope?.error)?.message ?? envelope?.error;
  return typeof message === "string" && /\breasoning_content\b/.test(message) &&
    /\b(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|not allowed)\b/i.test(message);
}

 export class RejectedToolCallError extends ChatProtocolError {
  readonly refusal: Record<string, unknown>;
  constructor(message: string, refusal: Record<string, unknown>) {
    super(message);
    this.refusal = refusal;
  }
}

const toolCallRefusal = (error: unknown) => {
  const body = object(error);
  return body?.code === "tool_use_failed" ? body : undefined;
};

function refusedToolCall(status: number, body: string) {
  if (status !== 400) return undefined;
  try { return toolCallRefusal(object(JSON.parse(body))?.error); } catch { return undefined; }
}

function completionError(json: CompletionJson, label: string): ChatProtocolError | null {
  const message = providerError(json);
  if (!message) return null;
  const text = `provider returned a ${label}: ${message.slice(0, 200)}`;
  const refusal = toolCallRefusal(json.error);
  return refusal ? new RejectedToolCallError(text, refusal) : new ChatProtocolError(text);
}

 export function refusedToolCallFailure(error: RejectedToolCallError, earlierSteps: boolean): string {
  const words = typeof error.refusal.message === "string" ? error.refusal.message : error.message;
  const tool = /attempted to call tool '([^']+)'/.exec(words)?.[1];
  const what = tool ? `tried to use a tool it was not given ("${tool}")` : "made a tool call the provider rejected";
  const next = earlierSteps
    ? "The steps before it already ran, so ask only for what's left."
    : "Nothing ran. Retry; if it keeps happening, rephrase the request or choose another model.";
  return `The model ${what}. ${next} Provider: ${words.slice(0, 200)}`;
}

export function createChatCompletion<Config>(options: RuntimeOptions<Config>) {
  return async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"],
  ): Promise<Completion> => {
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutController.abort(new DOMException("Streaming idle timeout elapsed", "AbortError"));
      }, options.timeoutMs);
    };

    resetIdleTimer();

    try {
      const activeSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const response = await fetch(`${options.apiUrl}/chat/completions`, {
        method: "POST",
        ...(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")) ? { redirect: "error" as const } : {}),
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...options.requestBody(model, messages, stream),
          ...(tools.length ? { tools } : {}),
        }),
        signal: activeSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (rejectsKey(response.status, body)) noteKeyRejected(options.apiUrl, options.apiKey);
        const message = `${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${httpErrorDetail(body)}` : ""}`;
        if (rejectsToolsParameter(response.status, body)) throw new UnsupportedChatToolsError(message);
        const refusal = refusedToolCall(response.status, body);
        if (refusal) throw new RejectedToolCallError(message, refusal);
        if (messages.some((entry) => entry.reasoning_content !== undefined) && rejectsReasoningReplay(response.status, body)) {
          throw new UnsupportedReasoningReplayError(message);
        }
        throw new Error(message);
      }
      noteKeyAccepted(options.apiUrl, options.apiKey);

      if (!stream || response.headers.get("content-type")?.includes("application/json")) {
        const json = await response.json() as CompletionJson;
        const tokenUsage = completionUsage(json);
        if (onUsage) {
          activeSignal.throwIfAborted();
          const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
          onUsage({
            model: typeof json.model === "string" && json.model.trim() ? json.model : model,
            input: count(tokenUsage?.prompt_tokens),
            output: count(tokenUsage?.completion_tokens),
            cachedInput: count(tokenUsage?.prompt_tokens_details?.cached_tokens),
            costUsd: count(tokenUsage?.cost),
          });
        }
        const bodyError = completionError(json, "completion error");
        if (bodyError) throw bodyError;
        const message = json.choices?.[0]?.message;
        if (!message || !object(message) || !["content", "reasoning_content", "reasoning", "reasoning_details", "tool_calls", "function_call"].some((key) => key in message)) {
          throw new ChatProtocolError("provider returned no completion message");
        }
        if (message?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        const calls = new ChatToolCalls();
        calls.add(message?.tool_calls, false);
        const details = new ChatReasoningDetails();
        details.add(message.reasoning_details);
        const reasoning = message.reasoning_content ?? message.reasoning;
        const finishReason = json.choices?.[0]?.finish_reason ?? null;
        activeSignal.throwIfAborted();
        return {
          text: options.contentText ? options.contentText(message?.content) : typeof message?.content === "string" ? message.content : "",
          reasoning: options.reasoning && typeof reasoning === "string"
            ? reasoning
            : "",
          usage: usageFrom(tokenUsage),
          toolCalls: calls.finish(finishReason, false),
          finishReason,
          protocolReasoning: typeof reasoning === "string" ? reasoning : "",
          protocolReasoningDetails: details.blocks,
        };
      }

      if (!response.body) {
        throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
      }
      let text = "";
      let reasoning = "";
      let protocolReasoning = "";
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      let malformedFrame = false;
      let sawChoice = false;
      const calls = new ChatToolCalls();
      const details = new ChatReasoningDetails();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeDataLine = (line: string, atEof = false): boolean => {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        let chunk: CompletionJson;
        try {
          chunk = JSON.parse(data) as CompletionJson;
        } catch {
          if (!atEof) malformedFrame = true;
          return false;
        }
        const chunkError = completionError(chunk, "streaming completion error");
        if (chunkError) throw chunkError;
        const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
        const delta = choice?.delta;
        if (object(delta)) sawChoice = true;
        if (delta?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        calls.add(delta?.tool_calls, true);
        details.add(delta?.reasoning_details);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
        const reasoningDelta = options.reasoning && typeof reasoningPart === "string"
          ? reasoningPart
          : "";
        const contentDelta = options.contentText ? options.contentText(delta?.content) : typeof delta?.content === "string" ? delta.content : "";
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          onDelta?.(contentDelta, "assistant_text");
        }
        const tokenUsage = completionUsage(chunk);
        if (tokenUsage) usage = usageFrom(tokenUsage);
        return false;
      };
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const line = buffer.trim();
            if (line && line !== "data: [DONE]") consumeDataLine(line, true);
            // MiniMax's api.minimax.io/v1 closes the connection after the
            // finish_reason chunk and never sends `[DONE]`.
            if (buffer.trim() === "data: [DONE]" || finishReason) break;
            if (!sawChoice) {
              let body: CompletionJson | undefined;
              try { body = JSON.parse(buffer) as CompletionJson; } catch { body = undefined; }
              const bodyError = body ? completionError(body, "completion error") : null;
              if (bodyError) throw bodyError;
            }
            throw new ChatProtocolError("Stream ended before completion");
          }
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (consumeDataLine(line)) break readLoop;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      activeSignal.throwIfAborted();
      if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
      return { text, reasoning, usage, toolCalls: calls.finish(finishReason, malformedFrame), finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

}
