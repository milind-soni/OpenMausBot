import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  TextGenerationOptions,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { ASK_USER_TOOL, ASK_USER_TOOL_DEFINITION, askQuestionSummary, parseAskQuestions, questionChoices } from "../../shared/ask-question.ts";
import { allowsTool, parseToolScope } from "../../shared/tool-scope.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolDefinition, type ChatToolSession, type ChatToolResult } from "./chat-mcp-tools.ts";
import { assertImageTransport, chatImageBudget, chatToolImages, chatUserContent, type ChatContentPart } from "./chat-images.ts";
import { promptHalves, volatileContextNote, withContextNote } from "./prompt-split.ts";
import { chatSessionOperationKey, createChatSessionMemory, createChatToolApproval } from "./chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { classifyContinuable, writeTurnHandoff } from "../turn-continuation.ts";
import { KEY_REJECTED_REASON, keyRejected, noteKeyAccepted, noteKeyRejected, rejectsKey } from "../key-rejections.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Record<string, unknown>[];
}

interface Usage {
  input: number;
  output: number;
}

interface Completion {
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
}

/** The message of a JSON error body a provider returned with HTTP 200.
 *  MiniMax reports auth, balance, and parameter failures as `base_resp`. */
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

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
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
  /** Field the provider reads replayed reasoning from; Cerebras rejects
   * `reasoning_content` and takes `reasoning`. */
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  /** Explicit text-only mode for endpoints/models that cannot accept tools. */
  tools?: boolean;
  /** Opt-in structured images and harness-authorized computer/browser MCP. */
  computerUse?: boolean;
  /** Whether a model accepts image parts (default: every model does). A
   * text-only model keeps the computer and browser tools, whose snapshots
   * and page reads are text, but never receives a screenshot or attachment. */
  imageInput?: (model: string) => boolean;
  /** Smaller models sometimes announce a step ("Checking the page first —")
   * and end the turn without calling a tool. When set, such a reply gets one
   * nudge per turn to act; a question, or anything longer, ends the turn. */
  nudgeAnnouncedAction?: boolean;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

class UnsupportedChatToolsError extends Error {}

/** One turn's safety stops: model steps, and tool calls across all of them.
 * Tool-heavy models (a memory server, a browser) take dozens of steps, and
 * a stopped turn cannot simply be continued — the next turn is rebuilt from
 * the text transcript, which holds none of these tool results. The calls
 * that ran have taken effect, so the stop asks only for what is left: a
 * retry of the whole task would repeat them. */
const MAX_CHAT_ROUNDS = 64;
const MAX_TURN_TOOL_CALLS = 200;
const stoppedAfter = (count: string) =>
  `Stopped after ${count} without a final answer. The steps so far already ran, so ask only for what's left.`;

const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Do it now with your tools, or reply with your final answer if nothing is left to do.";

/** A short reply that only announces a next step, with nothing to answer. */
export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 400 || reply.includes("?")) return false;
  return /(?:[:\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i.test(reply);
}

const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";
const TEXT_ONLY_SCREENSHOT_NOTE = "[Screenshot not shown: this model cannot see images. Read the page with a snapshot or a text tool instead.]";

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

class UnsupportedReasoningReplayError extends Error {}

/** DeepSeek-style providers need `reasoning_content` echoed on a tool-call
 *  assistant message; strict endpoints such as Groq reject the property. */
function rejectsReasoningReplay(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const message = object(envelope?.error)?.message ?? envelope?.error;
  return typeof message === "string" && /\breasoning_content\b/.test(message) &&
    /\b(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|not allowed)\b/i.test(message);
}

/** Groq checks each generated tool call against the request and fails the
 *  completion with `tool_use_failed` when the call is invalid: most often a
 *  tool it was not offered (gpt-oss inventing a "json" tool to answer in
 *  JSON), sometimes arguments that miss the schema. `refusal` is the
 *  provider's whole error object, `failed_generation` included. */
class RejectedToolCallError extends ChatProtocolError {
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

/** What a failed turn says once the provider refused every attempt: what
 *  happened, the next step, then the provider's words. The refused call ran
 *  nothing, but tool calls from earlier steps of the turn did, and a Retry
 *  of the whole request would repeat them. */
function refusedToolCallFailure(error: RejectedToolCallError, earlierSteps: boolean): string {
  const words = typeof error.refusal.message === "string" ? error.refusal.message : error.message;
  const tool = /attempted to call tool '([^']+)'/.exec(words)?.[1];
  const what = tool ? `tried to use a tool it was not given ("${tool}")` : "made a tool call the provider rejected";
  const next = earlierSteps
    ? "The steps before it already ran, so ask only for what's left."
    : "Nothing ran. Retry; if it keeps happening, rephrase the request or choose another model.";
  return `The model ${what}. ${next} Provider: ${words.slice(0, 200)}`;
}

/** Shared runtime for the three providers that speak OpenAI chat completions. */
export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
    /** Mid-turn user input parked by adapter.steer. Spliced into the
     * request array at the top of the next loop round — the one place the
     * array is between rounds, never mid-tool-batch — so the model reads
     * it before its next completion. Kept out of messages[] until then:
     * a parked item must never look like delivered input. */
    asides: string[];
  }>();
  /** Models whose endpoint rejected an echoed `reasoning_content`. In memory
   * only: later rounds and turns omit the field instead of failing again. */
  const reasoningReplayRejected = new Set<string>();
  /** Exact tool calls the person allowed for a thread. Process memory only. */
  const sessionMemory = createChatSessionMemory();

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
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"],
  ): Promise<Completion> => {
    // Idle timer that is renewed on every received chunk during streaming
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
        const message = `${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
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
        if (onUsage) {
          activeSignal.throwIfAborted();
          const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
          onUsage({
            model: typeof json.model === "string" && json.model.trim() ? json.model : model,
            input: count(json.usage?.prompt_tokens),
            output: count(json.usage?.completion_tokens),
            cachedInput: count(json.usage?.prompt_tokens_details?.cached_tokens),
            costUsd: count(json.usage?.cost),
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
          usage: usageFrom(json.usage),
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
          // A tail left in the buffer when the socket closed is an INCOMPLETE
          // frame, not a bad one: a stop, an abort or a dropped connection all
          // end mid-frame. Only a properly newline-terminated frame that will
          // not parse means the provider actually sent something malformed.
          // Counting the tail here turned a stopped turn into a hard,
          // non-retryable failure (`calls.finish(finishReason, malformedFrame)`).
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
        if (chunk.usage) usage = usageFrom(chunk.usage);
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

  const seesImages = (turn: SendTurnInput) =>
    options.imageInput?.(turn.model || options.models().default) ?? true;
  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => {
    // The system message is the head of the resent prefix, so only the
    // stable half belongs there: a volatile edit must not re-price the
    // tools, instructions and transcript the provider already cached.
    // The volatile half rides the newest user message instead, every
    // turn. Unlike a CLI session, this request is rebuilt from the stored
    // transcript, which never contains the delivered notes, so tracking a
    // digest and delivering only on change would leave the model without
    // its memory on unchanged turns. The newest message is fresh input
    // on every request anyway.
    const halves = promptHalves(turn);
    const note = halves.stable !== null ? volatileContextNote(halves.volatile, false) : "";
    const userTurn = note ? { ...turn, text: withContextNote(note, turn.text) } : turn;
    const system = halves.stable ?? turn.system;
    return [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...(turn.transcript ?? []).map((message) => ({
        role: message.role,
        content: message.text,
      })),
      { role: "user", content: !options.computerUse ? userTurn.text
        : seesImages(turn) ? chatUserContent(userTurn)
        : userTurn.images?.length ? `${userTurn.text}\n\n${TEXT_ONLY_ATTACHMENT_NOTE}` : userTurn.text },
    ];
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    if (options.computerUse && (turn.images?.length || turn.integrations?.localComputer || turn.integrations?.browser)) assertImageTransport(options.apiUrl);

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const retainImages = chatImageBudget();
    for (const message of messages) retainImages(message.content);
    const model = turn.model || options.models().default;
    const secrets = [options.apiKey].filter((value): value is string => Boolean(value));
    for (const integration of Object.values(turn.integrations ?? {})) {
      const entries = object(integration);
      const specs = entries && "command" in entries ? [entries] : Object.values(entries ?? {}).map(object);
      for (const spec of specs) {
        for (const [key, value] of Object.entries(object(spec?.env) ?? {})) {
          if (/key|token|password|secret|authorization/i.test(key) && typeof value === "string" && value) secrets.push(value);
        }
      }
    }
    const safeText = (text: string) => {
      let safe = text;
      for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
      return redactSecretsInText(safe);
    };
    const preview = (value: unknown) => toolDetailPreview(JSON.parse(JSON.stringify(value, (_key, part) =>
      typeof part === "string" ? safeText(part) : part)));
    const native = (dir: "out" | "in", msg: unknown) => appendNative(turn.threadId, {
      dir, source: options.nativeLog.source,
      msg: JSON.parse(JSON.stringify(msg, (_key, part) => typeof part === "string" ? safeText(part) : part)),
    });
    const approval = createChatToolApproval({
      signal: abort.signal,
      remember: (sessionKey) => sessionMemory.remember(turn.threadId, sessionKey),
      open: (ask) => emit({
        ...base(turn.threadId, turnId), type: "request.opened", requestType: "permission",
        requestId: ask.id, tool: ask.tool, summary: ask.summary,
        allowSession: ask.sessionKey ? true : false,
      }),
      resolved: (ask, allowed, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: allowed ? "allow" : "deny", source,
      }),
      openQuestion: (ask, questions) => {
        const choices = questionChoices(questions);
        emit({
          ...base(turn.threadId, turnId), type: "request.opened", requestType: "question",
          requestId: ask.id, tool: ask.tool, summary: ask.summary,
          questions, ...(choices ? { choices } : {}),
        });
      },
      resolvedQuestion: (ask, answered, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: answered ? "answer" : "deny", source,
      }),
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const turnEntry = { abort, turnId, done, approval, asides: [] as string[] };
    active.set(turn.threadId, turnEntry);
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let tools: ChatToolSession | undefined;
      const usage: Usage = { input: 0, output: 0 };
      let hasUsage = false;
      let ok = false;
      let stopReason: string | null = null;
      let failure: string | undefined;
      let toolFailed = false;
      const denials: string[] = [];
      const seenCalls = new Set<string>();
      let nudged = false;
      try {
        const parsed = parseToolScope(turn.toolScope);
        if (!parsed.ok) throw new Error(parsed.error);
        const scope = parsed.scope;
        tools = await mountChatTools(options.tools === false ? undefined : turn.integrations, abort.signal, options.computerUse, scope, turn.mcpCallTimeoutMs);
        const questionAllowed = options.tools !== false && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL });
        let optionalQuestionOnly = questionAllowed && tools.definitions.length === 0;
        // The runtime's one built-in tool rides the same list: ask_user is
        // how a chat-completions engine reaches a person. An MCP server that
        // squats the name cannot shadow it — dispatch intercepts the name
        // before validate — but the definition is then skipped so the list
        // never advertises two.
        if (questionAllowed && !tools.definitions.some((definition) => definition.function.name === ASK_USER_TOOL)) {
          tools.definitions.push(ASK_USER_TOOL_DEFINITION);
        }
        for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
          abort.signal.throwIfAborted();
          // Drain parked mid-turn input here, before the next completion
          // request: the previous round's tool results are complete, so a
          // user message lands on a consistent array (never inside a tool
          // batch) and the provider sees it as the newest input.
          const parked = turnEntry.asides.splice(0);
          if (parked.length) messages.push({ role: "user", content: parked.join("\n\n") });
          native("out", options.nativeLog.outgoing(turn, messages, model, tools.definitions));
          let attempt = 0;
          let completion: Completion;
          for (;;) {
            let streamed = false;
            let answerStreamed = false;
            const pending = { assistant_text: "", reasoning_text: "" };
            const delta = (text: string, streamKind: keyof typeof pending, flush = false) => {
              let combined = pending[streamKind] + text;
              // Mask complete matches before holding a suffix: otherwise a key
              // such as "abab" could be split at its own repeated prefix.
              for (const secret of secrets) if (secret) combined = combined.split(secret).join("[redacted]");
              let hold = 0;
              // A configured credential can straddle chunks. Hold any suffix
              // that could be its prefix until the next chunk disambiguates it.
              if (!flush) for (const secret of secrets) {
                for (let length = Math.min(secret.length - 1, combined.length); length > hold; length--) {
                  if (combined.endsWith(secret.slice(0, length))) { hold = length; break; }
                }
              }
              pending[streamKind] = hold ? combined.slice(-hold) : "";
              const visible = safeText(hold ? combined.slice(0, -hold) : combined);
              if (visible) emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind, delta: visible });
            };
            try {
              completion = await complete(messages, model, true, abort.signal, (text, streamKind) => {
                streamed = true;
                if (streamKind === "assistant_text") answerStreamed = true;
                delta(text, streamKind);
              }, tools.definitions);
              delta("", "assistant_text", true);
              delta("", "reasoning_text", true);
              break;
            } catch (value) {
              const error = asError(value);
              const verdict = classifyError(error);
              // A schema rejection of the echoed reasoning executed nothing
              // upstream, so the same transcript without that one property
              // repeats no operation. The error needs the field in the
              // request, so the stripped resend cannot loop.
              if (error instanceof UnsupportedReasoningReplayError && !streamed && !abort.signal.aborted) {
                reasoningReplayRejected.add(model);
                for (const message of messages) delete message.reasoning_content;
                continue;
              }
              // A refused tool call ran nothing, so the same request goes
              // again; the model usually answers properly next time. Not once
              // answer text streamed: the phones' live bubble would join it to
              // the next attempt's. Streamed thinking stays thinking. Each
              // refusal, failed_generation included, goes to the native log.
              if (error instanceof RejectedToolCallError) {
                native("in", { refused: "tool_use_failed", attempt: attempt + 1, error: error.refusal });
                if (!answerStreamed && !abort.signal.aborted && attempt < RETRY_MAX_ATTEMPTS - 1) {
                  emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: ++attempt, delayMs: 0, reason: "tool_use_failed" });
                  continue;
                }
                if (!abort.signal.aborted) throw new ChatProtocolError(refusedToolCallFailure(error, seenCalls.size > 0));
              }
              // Only our optional question changed a previously plain request.
              // A structured parameter rejection has executed nothing; never
              // downgrade mounted tools, streamed output or a handled call.
              if (optionalQuestionOnly && round === 0 && !streamed && !seenCalls.size && !abort.signal.aborted &&
                  error instanceof UnsupportedChatToolsError && verdict.reason === "invalid_request") {
                optionalQuestionOnly = false;
                tools.definitions.length = 0;
                continue;
              }
              // Once a call has been handled, never replay it through a turn retry.
              if (options.retryScale === undefined || abort.signal.aborted || streamed || seenCalls.size ||
                  error instanceof ChatProtocolError || !verdict.transient || attempt >= RETRY_MAX_ATTEMPTS - 1) throw error;
              const delayMs = computeBackoff(attempt++);
              emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: verdict.reason });
              await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
              abort.signal.throwIfAborted();
            }
          }
          native("in", options.nativeLog.incoming(completion));
          if (completion.usage) {
            usage.input += completion.usage.input;
            usage.output += completion.usage.output;
            hasUsage = true;
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          // Reasoning on a tool-call round belongs to the protocol, not a final reply.
          const reply = completion.text.trim() ? completion.text : completion.toolCalls.length ? "" : completion.reasoning;
          if (reply.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply) });
          abort.signal.throwIfAborted();
          if (!completion.toolCalls.length) {
            if (!reply.trim()) throw new ChatProtocolError("provider returned an empty response");
            if (completion.finishReason && completion.finishReason !== "stop") {
              throw new ChatProtocolError(`provider did not finish the response (${completion.finishReason})`);
            }
            if (options.nudgeAnnouncedAction && !nudged && tools.definitions.length && announcesAction(completion.text)) {
              nudged = true;
              messages.push({ role: "assistant", content: completion.text }, { role: "user", content: NUDGE_ANNOUNCED_ACTION });
              continue;
            }
            if (toolFailed) {
              // A failed or denied tool op ends the turn: the final answer is
              // not an execution receipt, and a person's "no" must never be
              // answered with a prompt to run the same thing again.
              stopReason = "tool_error";
              throw new ChatProtocolError("One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.");
            }
            ok = true;
            break;
          }
          if (!tools.definitions.length) throw new ChatProtocolError("provider returned tool calls, but no tools are available for this turn");
          // Validate IDs for the entire batch before executing any of its calls.
          for (const call of completion.toolCalls) {
            if (seenCalls.has(call.id)) throw new ChatProtocolError("provider reused a tool-call ID; refusing to repeat an operation");
            seenCalls.add(call.id);
          }
          // The whole batch is refused before any of it runs.
          if (seenCalls.size > MAX_TURN_TOOL_CALLS) throw new ChatProtocolError(stoppedAfter(`${MAX_TURN_TOOL_CALLS} tool calls`));
          messages.push({ role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls,
            ...(completion.protocolReasoning && !reasoningReplayRejected.has(model) ? { [options.reasoningReplayField ?? "reasoning_content"]: completion.protocolReasoning } : {}),
            ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
          });
          const screenshotParts: ChatContentPart[] = [];
          for (const call of completion.toolCalls) {
            abort.signal.throwIfAborted();
            let result: ChatToolResult;
            let started = false;
            let fatal: Error | undefined;
            try {
              let args: unknown;
              try { args = JSON.parse(call.function.arguments); }
              catch { throw new ChatProtocolError("tool arguments are not complete JSON"); }
              if (!object(args)) throw new ChatProtocolError("tool arguments must be a JSON object");
              const inputPreview = preview(args);
              if (call.function.name === ASK_USER_TOOL) {
                if (!questionAllowed || !allowsTool(scope, { kind: "native", name: ASK_USER_TOOL })) throw new Error("Tool selection excludes this tool");
                // A question is the person's card, not a permission, so it is
                // handled before the gate below: under Full access that gate
                // would auto-run an unanswered ask, and under Ask it would
                // render Allow/Deny over a question nobody can answer that way.
                const questions = parseAskQuestions(args);
                abort.signal.throwIfAborted();
                emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id,
                  title: call.function.name, ...(inputPreview ? { input: inputPreview } : {}),
                });
                started = true;
                if (!questions) {
                  denials.push(ASK_USER_TOOL);
                  result = { ok: false, text: "The ask_user arguments are malformed: pass a JSON object with a questions array of one to six questions, each with a question string and at most twelve options carrying a label. Ask again with valid arguments." };
                } else {
                  // The tool result is the card's Q:/A: reply verbatim — never
                  // a summary, and never words the person did not send.
                  const answer = await approval.question(ASK_USER_TOOL, askQuestionSummary(questions), questions);
                  abort.signal.throwIfAborted();
                  if (answer === null) {
                    // An unanswered question is absence, not a "no": the card
                    // timed out or the person closed it. Keep the turn alive so
                    // the model's final response stands; it is told not to
                    // guess and may ask again later. An explicit deny of a
                    // permission stays terminal.
                    result = { ok: true, text: "The person did not answer this question. Do not guess an answer; ask again later or proceed without it." };
                  } else {
                    result = { ok: true, text: answer };
                  }
                }
              } else {
                tools.validate(call.function.name, args);
                // A searched server's call_tool is shown as the tool it runs;
                // its catalog reads ask nothing, as listing tools never did.
                const shown = tools.view(call.function.name, args as Record<string, unknown>);
                const shownPreview = shown.input === args ? inputPreview : preview(shown.input);
                // Full access is the person's explicit grant to answer every
                // prompt. This runtime has no provider reviewer to hand it to,
                // so it is honoured here: without it every single tool call on
                // an OpenAI-compatible engine stops for a card, and a Chief's
                // delegated Full access cannot help either. A guest turn never
                // stores a session grant. Sends, computer control and browser
                // control stay a card every time.
                const sessionKey = turn.guestConfined || !shown.ask
                  ? null
                  : chatSessionOperationKey(shown.title, shown.input, shown.grant);
                const allowed = turn.approvalMode === "full" || !shown.ask
                  || (sessionKey !== null && sessionMemory.has(turn.threadId, sessionKey))
                  || await approval.ask(shown.title, shownPreview ?? "This tool has no arguments.", sessionKey);
                abort.signal.throwIfAborted();
                emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id,
                  title: shown.title, ...(shownPreview ? { input: shownPreview } : {}),
                });
                started = true;
                if (allowed) {
                  result = await tools.execute(call.function.name, args as Record<string, unknown>, abort.signal);
                  if (result.images?.length && !seesImages(turn)) {
                    const { images: _dropped, ...rest } = result;
                    result = { ...rest, text: `${rest.text}\n${TEXT_ONLY_SCREENSHOT_NOTE}` };
                  }
                  if (result.images?.length) {
                    try {
                      assertImageTransport(options.apiUrl);
                      retainImages(result.images);
                    } catch (error) {
                      throw new ChatToolSessionError(asError(error).message);
                    }
                  }
                } else {
                  denials.push(shown.title);
                  result = { ok: false, text: "Permission denied or expired; the tool was not executed." };
                }
              }
            } catch (error) {
              if (error instanceof ChatToolSessionError) fatal = error;
              result = { ok: false, text: abort.signal.aborted
                ? "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying."
                : safeText(asError(error).message).slice(0, 2_000) };
            }
            if (!started) emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id, title: call.function.name });
            const text = safeText(result.text);
            const output = preview({ ok: result.ok, result: text });
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok: result.ok, output });
            if (!result.ok) toolFailed = true;
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, result: text }) });
            screenshotParts.push(...chatToolImages(call.id, result.images));
            abort.signal.throwIfAborted();
            if (fatal) throw fatal;
          }
          if (screenshotParts.length) messages.push({ role: "user", content: screenshotParts });
        }
        if (!ok) throw new ChatProtocolError(stoppedAfter(`${MAX_CHAT_ROUNDS} steps`));
      } catch (value) {
        stopReason = abort.signal.aborted ? "interrupted" : stopReason ?? "error";
        failure = safeText(asError(value).message).slice(0, 2_000);
      } finally {
        approval.close();
        let cleanupFailed = false;
        try { await tools?.close(); }
        catch {
          ok = false;
          stopReason = "error";
          cleanupFailed = true;
          failure = "Tool processes could not be stopped; their execution state is uncertain.";
        }
        if (abort.signal.aborted) { ok = false; stopReason = "interrupted"; }
        if (failure && (!abort.signal.aborted || cleanupFailed)) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: failure, terminal: !abort.signal.aborted });
        }
        // Automatic continuity: a resumable terminal (the step or tool-call
        // cap) persists a handoff and raises cap.exhausted so the harness
        // can start a `Continue:` thread. Interruptions, tool errors and
        // provider errors (a rate limit included) are excluded by
        // classifyContinuable.
        if (!ok && !abort.signal.aborted) {
          const continuable = classifyContinuable(stopReason, failure);
          if (continuable) {
            const handoffPath = writeTurnHandoff({
              threadId: turn.threadId,
              turnId,
              model,
              usage,
              hasUsage,
              failure,
              toolCalls: seenCalls.size,
              messages,
            });
            if (handoffPath) emit({ ...base(turn.threadId, turnId), type: "cap.exhausted", handoffPath, reason: continuable });
          }
        }
        active.delete(turn.threadId);
        emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok, stopReason, cost: null,
          ...(hasUsage && (options.includeUsageInCompleted || seenCalls.size) ? { usage } : {}),
          ...(denials.length ? { denials } : {}),
        });
        resolveDone();
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
    snapshot: async () => {
      if (!options.apiKey) return { state: "unavailable", reason: options.unavailableReason };
      if (keyRejected(options.apiUrl, options.apiKey)) return { state: "available", authenticated: false, reason: KEY_REJECTED_REASON, version: null };
      return { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) };
    },
    adapter: {
      provider: options.driverKind,
      capabilities: { ...(options.computerUse ? { computerMcp: options.tools !== false,
        localComputerMcp: options.tools !== false,
        browserMcp: options.tools !== false, nativeImageInput: true, images: true } : {}),
        sessionModelSwitch: "in-session", customMcp: options.tools !== false, agentsMcp: options.tools !== false, composioMcp: options.tools !== false,
        // The runtime owns the whole tool loop, so it can always take a
        // user message mid-turn: park it, deliver before the next completion.
        queueing: true,
        // No shell and no file tool on the host at all: only MCP tools, each
        // call a card in Ask (the Boat's `exec` runs on the Boat). A guest's
        // turn is as confined as it gets.
        guestTurns: "confined" },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.abort.abort();
        await turn.done;
      },
      respondToRequest: async (threadId, requestId, decision) =>
        active.get(threadId)?.approval.answer(requestId, decision.behavior, decision.message, decision.always) ?? "unavailable",
      steer: async (threadId, text) => {
        // This engine has no external session to respect — parking the
        // words in the live turn's entry IS delivery into the loop, so a
        // successful park is "steered" and a missing turn is the only
        // refusal. The words ride the array at the next round boundary;
        // if the turn settles first, the harness's transcript record
        // keeps them for the next turn (they are never re-sent here).
        const running = active.get(threadId);
        if (!running) return "refused";
        running.asides.push(text);
        return "steered";
      },
      hasSession: (threadId) => active.has(threadId),
      forgetThread: (threadId) => sessionMemory.forget(threadId),
      stopAll: async () => {
        const turns = [...active.values()];
        for (const turn of turns) turn.abort.abort();
        await Promise.all(turns.map((turn) => turn.done));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt, { signal, onUsage } = {}) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false, signal, undefined, [], onUsage);
      if (toolCalls.length) throw new ChatProtocolError("provider returned tool calls to a text-only helper");
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      const turns = [...active.values()];
      for (const turn of turns) turn.abort.abort();
      await Promise.all(turns.map((turn) => turn.done));
      listeners.clear();
      sessionMemory.clear();
    },
  };
}
