import { RuntimeNoticeError, runtimeErrorText } from "./runtime-notice-error.ts";
import { createHash } from "node:crypto";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance, ProviderSnapshot,
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
import { ChatToolSessionError, chatToolNotices, mountChatTools, refitChatTools, type ChatToolDefinition, type ChatToolSession, type ChatToolResult } from "./chat-mcp-tools.ts";
import { noteToolBudget } from "../tool-budgets.ts";
import { chatToolLimitFor, chatToolLimitKey } from "../tool-count-limit.ts";
import { assertImageTransport, chatImageBudget, chatToolImages, chatUserContent, type ChatContentPart } from "./chat-images.ts";
import { promptHalves, volatileContextNote, withContextNote } from "./prompt-split.ts";
import { createChatToolApproval, refusal } from "./chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { completionError, httpErrorDetail, refusedToolCall, refusedToolCallFailure, rejectsReasoningReplay, rejectsToolsParameter, RejectedToolCallError, StreamTruncatedError, UnsupportedChatToolsError, UnsupportedReasoningReplayError, type ProviderBody } from "./openai-chat-refusals.ts";
import { ChatRepeatGuard } from "./chat-repeat-guard.ts";
import { TextCallHoldback, textToolCalls } from "./chat-text-tool-calls.ts";
import { createModelRoutes, ModelRouteRefused, noRouteLeft, readResponsesStream, responsesRequest, routeRefusal, type ModelRoute, type ResponseItem } from "./openai-responses.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { plainFailure } from "./engine-errors.ts";
import { noticeFailure } from "../chat-notices.ts";
import { toolFailureMessage } from "./tool-failure.ts";
import { refusesRequestSize, RequestTooLargeError, sizeChange, smallerResend } from "./chat-size-limit.ts";
import { requestTooLargeMessage } from "../../shared/request-too-large.ts";
import { toolSchemaProfileFor } from "../tool-schema-profile.ts";
import { classifyContinuable, writeTurnHandoff } from "../turn-continuation.ts";
import { KEY_REJECTED_REASON, keyRejected, noteKeyAccepted, noteKeyRejected, rejectsKey } from "../key-rejections.ts";
import { FETCH_LIMIT_MS, fetchPastLimit } from "./openai-chat-fetch.ts";
import { announcesAction } from "./chat-announcement.ts";

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

export interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
  /** Every output item of a Responses API reply, encrypted reasoning included, for the next round of this turn only. */
  responseOutput?: ResponseItem[];
}

interface CompletionJson extends ProviderBody {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

const LIVENESS_MISSES = 3;

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean, variant?: string): Record<string, unknown>;
  httpErrorLabel: string;
  /** A refusal this provider words itself: the sentence the person sees instead of the HTTP line, or undefined. */
  plainRefusal?: (status: number, body: string) => string | undefined;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  /** Ask a server on this machine or network for its models this often while a reply is pending, and stop the reply
   * when it misses LIVENESS_MISSES checks in a row: it crashed, froze or left the network. */
  livenessEveryMs?: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  /** Cerebras rejects `reasoning_content` and takes `reasoning`. */
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  tools?: boolean;
  computerUse?: boolean;
  /** A text-only model keeps the computer and browser tools but never receives a screenshot or attachment. */
  imageInput?: (model: string) => boolean;
  /** Some models list `variants`; the picked one reaches `requestBody`. */ modelVariants?: boolean;
  /** False for a model its server says cannot call tools: its turns go without them instead of being refused. */ toolUse?: (model: string) => boolean;
  /** Why the server cannot answer now (not running, nothing to run), asked before the key is. */
  serverUnavailable?: () => Promise<Pick<ProviderSnapshot, "reason" | "ollama"> | null>;
  /** The name to send for a model, when its server knows it by another. */
  servedModel?: (model: string) => Promise<string>;
  /** Smaller models announce a step and end the turn without calling a tool; such a reply gets a nudge, at most three
   * per turn and each only after tool progress since the last. */
  nudgeAnnouncedAction?: boolean;
  /** A model on this machine or network: read a tool call it wrote as text, stop it repeating itself, and send it back
   * to fix a failed call instead of ending the turn on it. */
  localModel?: boolean;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const MAX_CHAT_ROUNDS = 64;
const MAX_TURN_TOOL_CALLS = 200;
const MAX_ANNOUNCEMENT_NUDGES = 3;
const stoppedAfter = (count: string) =>
  `Stopped after ${count} without a final answer. The steps so far already ran, so ask only for what's left.`;

interface DeliveredUserMessage {
  text: string;
  sent: string;
  volatile?: string;
  after: string;
}

const MAX_REPLAY_EXTRA_BYTES = 24_000;
const MAX_DELIVERED_THREADS = 256;

const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url");

function replayDelivered(
  transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  records: readonly DeliveredUserMessage[],
): { content: Map<number, string>; matched: DeliveredUserMessage[]; volatile: string | undefined } {
  const found: Array<{ index: number; record: DeliveredUserMessage }> = [];
  let next = records.length - 1;
  for (let index = transcript.length - 1; index >= 0 && next >= 0; index--) {
    const message = transcript[index]!;
    if (message.role !== "user" || !message.text) continue;
    const after = index > 0 ? fingerprint(transcript[index - 1]!.text) : undefined;
    for (let at = next; at >= 0; at--) {
      const record = records[at]!;
      if (record.text !== message.text && !record.text.endsWith("\n\n" + message.text)) continue;
      if (after !== undefined && record.after !== after) continue;
      found.unshift({ index, record });
      next = at - 1;
      break;
    }
  }
  const content = new Map<number, string>();
  let volatile: string | undefined;
  let budget = MAX_REPLAY_EXTRA_BYTES;
  for (const { index, record } of found) {
    const extra = Buffer.byteLength(record.sent) - Buffer.byteLength(transcript[index]!.text);
    if (extra > budget) break;
    budget -= extra;
    content.set(index, record.sent);
    if (record.volatile !== undefined) volatile = record.volatile;
  }
  return { content, matched: found.map(({ record }) => record), volatile };
}

const CORRECTIVE_ROUND = "[OpenMausBot: a tool call in this turn failed (its result is marked ok:false). Re-run the failed operations with corrected inputs where possible, check the results, then give your final answer. Do not report results you did not get.]";
const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

const UNREADABLE_CALL = "[OpenMausBot: your last tool call could not be read, so nothing ran. Call the tool again using only the tools you were given, with valid JSON arguments.]";
const LOCAL_CORRECTIVE_ROUNDS = 2;

const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";
const TEXT_ONLY_SCREENSHOT_NOTE = "[Screenshot not shown: this model cannot see images. Read the page with a snapshot or a text tool instead.]";

export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
    /** Mid-turn input parked by adapter.steer, spliced in at the next round, never mid-tool-batch. */
    asides: string[];
    /** Set once the turn stops taking rounds: a later steer goes to the next turn instead. */
    ending: boolean;
  }>();
  const reasoningReplayRejected = new Set<string>();
  const routes = createModelRoutes(options.apiUrl);
  /** Beside the messages, not on them, so encrypted reasoning never reaches a Chat Completions body, a log or a handoff. */
  const responseOutputs = new WeakMap<OpenAIChatMessage, ResponseItem[]>();
  const assistantReply = (model: string, completion: Completion, content: string | null, toolCalls?: ChatToolCall[]): OpenAIChatMessage => {
    const reply: OpenAIChatMessage = { role: "assistant", content,
      ...(completion.protocolReasoning && !reasoningReplayRejected.has(model) ? { [options.reasoningReplayField ?? "reasoning_content"]: completion.protocolReasoning } : {}),
      ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    if (completion.responseOutput) responseOutputs.set(reply, completion.responseOutput);
    return reply;
  };
  const delivered = new Map<string, DeliveredUserMessage[]>();
  /** Not cleared on `sessionReset`: with no cursor the harness sends it on nearly every turn. */
  const sessionGrants = new Map<string, Set<string>>();

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

  const watchServer = (everyMs: number, stop: (reason: Error) => void) => {
    let misses = 0;
    const timer = setInterval(() => {
      fetch(`${options.apiUrl}/models`, { headers: { authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(everyMs) })
        .then((response) => { misses = 0; void response.body?.cancel(); })
        .catch(() => {
          if (++misses === LIVENESS_MISSES) stop(new RuntimeNoticeError(`The model server at ${new URL(options.apiUrl).host} stopped answering, so the reply was stopped.`, "chat.notice.modelServerStoppedAnswering", { host: new URL(options.apiUrl).host }));
        });
    }, everyMs);
    timer.unref();
    return timer;
  };

  const completeOn = async (
    route: ModelRoute,
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"], variant?: string,
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
    const liveness = options.livenessEveryMs ? watchServer(options.livenessEveryMs, (reason) => timeoutController.abort(reason)) : null;

    try {
      const activeSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const served = options.servedModel ? await options.servedModel(model) : model;
      const payload = JSON.stringify(route === "responses"
        ? responsesRequest({ model: served, messages, tools, replay: (message) => responseOutputs.get(message), summaries: routes.summaries(model), effort: options.requestBody(served, messages, stream, variant).reasoning_effort })
        : {
          ...options.requestBody(served, messages, stream, variant),
          ...(route === "chat-reasoning-off" ? { reasoning_effort: "none" } : {}),
          ...(tools.length ? { tools } : {}),
        });
      const send = options.timeoutMs > FETCH_LIMIT_MS ? fetchPastLimit : fetch;
      const response = await send(`${options.apiUrl}/${route === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST",
        ...(route === "responses" || messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")) ? { redirect: "error" as const } : {}),
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: payload,
        signal: activeSignal,
      });
      const failure = (status: number, body: string): Error => {
        const plain = options.plainRefusal?.(status, body); if (plain) return new Error(plain);
        const message = `${options.httpErrorLabel} HTTP ${status}${body ? `: ${httpErrorDetail(body)}` : ""}`;
        const refused = tools.length ? routeRefusal(route, status, body) : null;
        if (refused) return new ModelRouteRefused(refused, message);
        if (rejectsKey(status, body)) noteKeyRejected(options.apiUrl, options.apiKey);
        if (refusesRequestSize(status, body)) return new RequestTooLargeError(message, Buffer.byteLength(payload));
        if (rejectsToolsParameter(status, body)) return new UnsupportedChatToolsError(message);
        const refusal = refusedToolCall(status, body);
        if (refusal) return new RejectedToolCallError(message, refusal);
        if (messages.some((entry) => entry.reasoning_content !== undefined) && rejectsReasoningReplay(status, body)) {
          return new UnsupportedReasoningReplayError(message);
        }
        return new Error(message);
      };
      if (!response.ok) throw failure(response.status, await response.text().catch(() => ""));
      noteKeyAccepted(options.apiUrl, options.apiKey);
      if (route === "responses") {
        const reply = await readResponsesStream(response.body, { reasoning: Boolean(options.reasoning), onBytes: resetIdleTimer, onDelta: (text, kind) => onDelta?.(text, kind), fail: failure });
        activeSignal.throwIfAborted();
        return reply;
      }

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
        const calls = new ChatToolCalls();
        calls.add(message?.tool_calls, false);
        calls.addLegacy(message.function_call);
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
          // A tail left when the socket closed is an incomplete frame (stop, abort, drop), not a malformed one.
          if (!atEof) malformedFrame = true;
          return false;
        }
        const chunkError = completionError(chunk, "streaming completion error");
        if (chunkError) throw chunkError;
        const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
        const delta = choice?.delta;
        if (object(delta)) sawChoice = true;
        calls.add(delta?.tool_calls, true);
        calls.addLegacy(delta?.function_call);
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
            throw new StreamTruncatedError("Stream ended before completion");
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
    } catch (error) {
      if (timeoutController.signal.reason instanceof RuntimeNoticeError) throw timeoutController.signal.reason;
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (liveness) clearInterval(liveness);
    }
  };

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"], variant?: string,
  ): Promise<Completion> => {
    for (;;) {
      let replied = false;
      try {
        return await completeOn(routes.routeFor(model, tools.length > 0), messages, model, stream, signal, onDelta && ((text, kind) => {
          replied = true;
          onDelta(text, kind);
        }), tools, onUsage, variant);
      } catch (error) {
        if (!(error instanceof ModelRouteRefused) || replied || signal?.aborted) throw error;
        if (!routes.advance(model, error.refusal)) throw new ChatProtocolError(noRouteLeft(error.message));
        console.warn(`${options.driverKind}: ${model} answered ${error.refusal}; now on ${routes.routeFor(model, true)}`);
      }
    }
  };

  const seesImages = (turn: SendTurnInput) =>
    options.imageInput?.(turn.model || options.models().default) ?? true;
  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => {
    const halves = promptHalves(turn);
    const transcript = turn.transcript ?? [];
    const replay = replayDelivered(transcript, delivered.get(turn.threadId) ?? []);
    const volatile = halves.volatile.trim();
    const note = halves.stable === null || (!turn.mentionTurn && replay.volatile === volatile) ? ""
      : volatileContextNote(volatile, Boolean(replay.volatile));
    const textOnly = (text: string) => !options.computerUse || seesImages(turn) || !turn.images?.length ? text
      : `${text}\n\n${TEXT_ONLY_ATTACHMENT_NOTE}`;
    const userTurn = note ? { ...turn, text: withContextNote(note, turn.text) } : turn;
    const content = options.computerUse && seesImages(turn) ? chatUserContent(userTurn) : textOnly(userTurn.text);
    const kept = turn.recalled ? turn.text.replace(`${turn.recalled}\n\n`, "") : turn.text;
    const record = {
      text: kept,
      sent: textOnly(withContextNote(note, kept)),
      ...(note ? { volatile } : {}),
      after: transcript.length ? fingerprint(transcript.at(-1)!.text) : "",
    };
    delivered.delete(turn.threadId);
    delivered.set(turn.threadId, [...replay.matched, record]);
    if (delivered.size > MAX_DELIVERED_THREADS) delivered.delete(delivered.keys().next().value!);
    const system = halves.stable ?? turn.system;
    return [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...transcript.map((message, index) => ({
        role: message.role,
        content: replay.content.get(index) ?? message.text,
      })),
      { role: "user", content },
    ];
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    if (options.computerUse && ((turn.images?.length && seesImages(turn)) || turn.integrations?.localComputer || turn.integrations?.browser)) assertImageTransport(options.apiUrl);

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const request = messages.at(-1)!;
    const retainImages = chatImageBudget();
    for (const message of messages) retainImages(message.content);
    const model = turn.model || options.models().default;
    const maskable = (value: unknown): value is string => typeof value === "string" && value.length >= 8; // a short placeholder key ("1") would redact every match
    const secrets = [options.apiKey].filter(maskable);
    for (const integration of Object.values(turn.integrations ?? {})) {
      const entries = object(integration);
      const specs = entries && "command" in entries ? [entries] : Object.values(entries ?? {}).map(object);
      for (const spec of specs) {
        for (const [key, value] of Object.entries(object(spec?.env) ?? {})) {
          if (/key|token|password|secret|authorization/i.test(key) && maskable(value)) secrets.push(value);
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
    const grantsKey = JSON.stringify([turn.threadId, turn.botId ?? null]);
    const granted = sessionGrants.get(grantsKey) ?? new Set<string>();
    sessionGrants.delete(grantsKey);
    sessionGrants.set(grantsKey, granted);
    if (sessionGrants.size > MAX_DELIVERED_THREADS) sessionGrants.delete(sessionGrants.keys().next().value!);
    const approval = createChatToolApproval({
      signal: abort.signal,
      granted: turn.guestConfined ? undefined : granted,
      open: (ask) => emit({
        ...base(turn.threadId, turnId), type: "request.opened", requestType: "permission",
        requestId: ask.id, tool: ask.tool, summary: ask.summary, allowSession: ask.grant !== undefined,
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
    const turnEntry = { abort, turnId, done, approval, asides: [] as string[], ending: false };
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
      let failureText: ReturnType<typeof runtimeErrorText>;
      let toolFailed = false;
      let correctiveRounds = 0;
      const denials: string[] = [], failedCalls: string[] = [];
      const seenCalls = new Set<string>();
      let nudges = 0;
      let unread: string[] = [];
      let callsAtNudge = -1;
      const repeats = options.localModel ? new ChatRepeatGuard() : undefined;
      let unreadable = false, askedAgain = false;
      try {
        const parsed = parseToolScope(turn.toolScope);
        if (!parsed.ok) throw new Error(parsed.error);
        const scope = parsed.scope;
        const toolsOff = options.tools === false || options.toolUse?.(model) === false;
        tools = await mountChatTools(toolsOff ? undefined : turn.integrations, abort.signal, options.computerUse, scope, turn.mcpCallTimeoutMs,
          toolSchemaProfileFor({ url: options.apiUrl, model }), turn.cwd ?? turn.toolResultFolder, safeText, chatToolLimitFor(options.apiUrl, model));
        noteToolBudget(turn.botId, tools.budget);
        for (const message of chatToolNotices(tools)) emit({ ...base(turn.threadId, turnId), type: "runtime.notice", message: safeText(message) });
        const questionAllowed = !toolsOff && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL });
        let optionalQuestionOnly = questionAllowed && tools.definitions.length === 0;
          // An MCP server squatting ask_user cannot shadow it (dispatch intercepts the name); skip its definition.
        if (questionAllowed && !tools.definitions.some((definition) => definition.function.name === ASK_USER_TOOL)) {
          tools.definitions.push(ASK_USER_TOOL_DEFINITION);
        }
        for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
          abort.signal.throwIfAborted();
            // Between rounds, never inside a tool batch.
          unread = turnEntry.asides.splice(0);
          if (unread.length) messages.push({ role: "user", content: unread.join("\n\n") });
          turnEntry.ending = round === MAX_CHAT_ROUNDS - 1;
          native("out", options.nativeLog.outgoing(turn, messages, model, tools.definitions));
          let attempt = 0;
          let resized = false;
          let completion: Completion;
          for (;;) {
            let streamed = false;
            let answerStreamed = false;
            const holdback = options.localModel && tools.definitions.length ? new TextCallHoldback() : undefined;
            const pending = { assistant_text: "", reasoning_text: "" };
            const delta = (text: string, streamKind: keyof typeof pending, flush = false) => {
              let combined = pending[streamKind] + text;
              // Mask whole matches before holding a suffix, or "abab" could split at its own repeated prefix.
              for (const secret of secrets) if (secret) combined = combined.split(secret).join("[redacted]");
              let hold = 0;
              // A configured credential can straddle chunks: hold any suffix that could be its prefix.
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
                const shown = holdback && streamKind === "assistant_text" ? holdback.feed(text) : text;
                if (shown) delta(shown, streamKind);
              }, tools.definitions, undefined, turn.variant);
              // A reply cut off at the token limit may be a call cut short; running half of one is worse than saying so.
              const written = holdback && !completion.toolCalls.length && completion.finishReason !== "length" ? textToolCalls(completion.text, tools.definitions) : null;
              unreadable = written?.kind === "unreadable" && !askedAgain;
              if (written?.kind === "calls") {
                completion = { ...completion, text: written.text, toolCalls: written.calls, finishReason: "tool_calls" };
                native("in", { recovered: "text_tool_calls", calls: written.calls.map((call) => call.function.name) });
              } else if (unreadable) {
                completion = { ...completion, text: written!.text };
                native("in", { recovered: "unreadable_tool_call" });
              } else {
                const rest = holdback?.rest();
                if (rest) delta(rest, "assistant_text");
              }
              delta("", "assistant_text", true);
              delta("", "reasoning_text", true);
              break;
            } catch (value) {
              const error = asError(value);
              const verdict = classifyError(error);
              // A provider refuses a request with too many tools before running anything: learn its limit and list fewer.
              const refit = streamed || seenCalls.size || abort.signal.aborted ? undefined : await refitChatTools(tools, error, chatToolLimitKey(options.apiUrl, model), [ASK_USER_TOOL_DEFINITION]);
              if (refit) {
                for (const message of refit) emit({ ...base(turn.threadId, turnId), type: "runtime.notice", message: safeText(message) });
                noteToolBudget(turn.botId, tools.budget);
                emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: 1, delayMs: 0, reason: "tool_limit" });
                continue;
              }
              // A rejected reasoning echo executed nothing upstream, so the stripped resend repeats nothing.
              if (error instanceof UnsupportedReasoningReplayError && !streamed && !abort.signal.aborted) {
                reasoningReplayRejected.add(model);
                for (const message of messages) delete message.reasoning_content;
                continue;
              }
              // A provider refuses an oversized request before running anything, so one smaller copy may go again.
              if (error instanceof RequestTooLargeError && !abort.signal.aborted) {
                const resend = resized ? null : smallerResend(messages, request, error.bytes);
                native("out", { refused: "request_too_large", bytes: error.bytes, ...(resend ? { before: resend.before, after: resend.after } : {}) });
                console.warn(`${options.driverKind}: ${model} refused a ${error.bytes}-byte request as too large; ${resend ? `resending smaller (${sizeChange(resend.before, resend.after)})` : "not resending"}`);
                if (!resend) throw new ChatProtocolError(requestTooLargeMessage(options.models().options.find((option) => option.id === model)?.label ?? model));
                messages.splice(0, messages.length, ...resend.messages);
                resized = true;
                emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: 1, delayMs: 0, reason: "request_too_large" });
                continue;
              }
              // A refused tool call ran nothing, so the request goes again, but not once answer text streamed.
              if (error instanceof RejectedToolCallError) {
                native("in", { refused: "tool_use_failed", attempt: attempt + 1, error: error.refusal });
                if (!answerStreamed && !abort.signal.aborted && attempt < RETRY_MAX_ATTEMPTS - 1) {
                  emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: ++attempt, delayMs: 0, reason: "tool_use_failed" });
                  continue;
                }
                if (!abort.signal.aborted) throw new ChatProtocolError(refusedToolCallFailure(error, seenCalls.size > 0));
              }
              // A structured parameter rejection executed nothing; never downgrade mounted tools or a handled call.
              if (optionalQuestionOnly && round === 0 && !streamed && !seenCalls.size && !abort.signal.aborted &&
                  error instanceof UnsupportedChatToolsError && verdict.reason === "invalid_request") {
                optionalQuestionOnly = false;
                tools.definitions.length = 0;
                continue;
              }
              // Never replay a handled call. A stream closed before any completion marker ran nothing upstream, so it may resend even where the caller never opted into retries.
              const truncation = error instanceof StreamTruncatedError, retryScale = truncation ? options.retryScale ?? 1 : options.retryScale;
              if (retryScale === undefined || abort.signal.aborted || streamed || seenCalls.size || (!truncation && (error instanceof ChatProtocolError || !verdict.transient)) || attempt >= RETRY_MAX_ATTEMPTS - 1) throw error;
              const delayMs = computeBackoff(attempt++);
              emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: truncation ? "stream_truncated" : verdict.reason });
              await interruptibleDelay(delayMs * retryScale, abort.signal).promise;
              abort.signal.throwIfAborted();
            }
          }
          native("in", options.nativeLog.incoming(completion));
          unread = [];
          if (completion.usage) {
            usage.input += completion.usage.input;
            usage.output += completion.usage.output;
            hasUsage = true;
            const contextWindow = options.models().options.find((entry) => entry.id === model)?.contextWindow;
            // Accounting sums the turn; context occupancy is the latest round only.
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage,
              contextTokens: completion.usage.input + completion.usage.output, ...(contextWindow ? { contextWindow } : {}) });
          }
          // Reasoning on a tool-call round belongs to the protocol, not a final reply.
          const reply = completion.text.trim() ? completion.text : completion.toolCalls.length || unreadable ? "" : completion.reasoning;
          if (reply.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply) });
          abort.signal.throwIfAborted();
          if (unreadable) {
            askedAgain = true;
            messages.push(assistantReply(model, completion, completion.text), { role: "user", content: UNREADABLE_CALL });
            continue;
          }
          if (!completion.toolCalls.length) {
            if (!reply.trim()) throw new ChatProtocolError("provider returned an empty response");
            if (completion.finishReason && completion.finishReason !== "stop") {
              throw new ChatProtocolError(`provider did not finish the response (${completion.finishReason})`);
            }
            if (toolFailed) {
              // A person's "no" is never answered with another attempt; a failure may first get the configured corrective rounds.
              if (!denials.length && !turnEntry.ending && correctiveRounds < Math.max(turn.toolErrorCorrectiveRounds ?? 0, options.localModel ? LOCAL_CORRECTIVE_ROUNDS : 0)) {
                correctiveRounds += 1;
                messages.push({ role: "user", content: CORRECTIVE_ROUND });
                continue;
              }
              stopReason = "tool_error";
              throw new ChatProtocolError(toolFailureMessage(failedCalls, denials.filter((name) => name !== ASK_USER_TOOL)));
            }
            if (options.nudgeAnnouncedAction && tools.definitions.length && announcesAction(completion.text)) {
              if (nudges >= MAX_ANNOUNCEMENT_NUDGES || turnEntry.ending) {
                stopReason = "incomplete_action";
                throw new ChatProtocolError(`Stopped after ${turnEntry.ending ? `${MAX_CHAT_ROUNDS} steps` : `${MAX_ANNOUNCEMENT_NUDGES} announcement nudges`} without a verified final answer. Earlier operations may have taken effect; inspect their state and continue only the remaining work.`);
              }
              if (callsAtNudge === seenCalls.size) {
                stopReason = "incomplete_action";
                throw new ChatProtocolError("The model announced another action without tool progress after a nudge. The task is incomplete; earlier operations may have taken effect. Inspect their state before continuing.");
              }
              nudges += 1;
              callsAtNudge = seenCalls.size;
              messages.push(assistantReply(model, completion, completion.text), { role: "user", content: NUDGE_ANNOUNCED_ACTION });
              continue;
            }
            if (turnEntry.asides.length) {
              messages.push(assistantReply(model, completion, reply));
              continue;
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
          if (seenCalls.size > MAX_TURN_TOOL_CALLS) throw new ChatProtocolError(stoppedAfter(`${MAX_TURN_TOOL_CALLS} tool calls`));
          messages.push(assistantReply(model, completion, completion.text || null, completion.toolCalls));
          // A failure stays pending only until the bot runs tools again: one that went on to use more tools has read the error
          // and reacted (a wrong guess, a bad query, then the right call), so its turn is not failed for it, on any model. The
          // failed step still shows as failed; a failure in the last calls before the answer, or a person's no, still ends it.
          if (!denials.length) { toolFailed = false; failedCalls.length = 0; }
          const screenshotParts: ChatContentPart[] = [];
          for (const call of completion.toolCalls) {
            abort.signal.throwIfAborted();
            let result: ChatToolResult;
            let started = false;
            let fatal: Error | undefined, title = call.function.name, skipRepeatCount = false;
            try {
              let args: unknown;
              try { args = JSON.parse(call.function.arguments); }
              catch { throw new ChatProtocolError("tool arguments are not complete JSON"); }
              if (!object(args)) throw new ChatProtocolError("tool arguments must be a JSON object");
              const inputPreview = preview(args);
              if (call.function.name === ASK_USER_TOOL) {
                if (!questionAllowed || !allowsTool(scope, { kind: "native", name: ASK_USER_TOOL })) throw new Error("Tool selection excludes this tool");
                // A question goes before the gate: Full would auto-run an unanswered ask, Ask would show Allow/Deny.
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
                  const answer = await approval.question(ASK_USER_TOOL, askQuestionSummary(questions), questions);
                  abort.signal.throwIfAborted();
                  if (answer === null) {
                    result = { ok: true, text: "The person did not answer this question. Do not guess an answer; ask again later or proceed without it." };
                  } else {
                    result = { ok: true, text: answer };
                  }
                }
              } else {
                const refused = repeats?.refuses(call.function.name, call.function.arguments);
                if (refused) { skipRepeatCount = true; throw new Error(refused); }
                tools.validate(call.function.name, args);
                const shown = tools.view(call.function.name, args as Record<string, unknown>); title = shown.title;
                const shownPreview = shown.input === args ? inputPreview : preview(shown.input);
                // This runtime has no provider reviewer, so Full access is honoured here.
                const full = (turn.approvalModeNow?.() ?? turn.approvalMode) === "full";
                const floored = approval.floored({ full, threadId: turn.threadId, botId: turn.botId, shown, summary: shownPreview });
                const allowed = !floored && (full || !shown.ask
                  || await approval.ask(shown.title, shownPreview ?? "This tool has no arguments.", shown.grant));
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
                  result = { ok: false, text: refusal(floored, (message) => emit({ ...base(turn.threadId, turnId), type: "runtime.notice", message })) };
                }
              }
            } catch (error) {
              if (error instanceof ChatToolSessionError) fatal = error;
              result = { ok: false, text: abort.signal.aborted
                ? "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying."
                : safeText(asError(error).message).slice(0, 2_000) };
            }
            if (!started) emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id, title: call.function.name });
            const repeatNote = skipRepeatCount ? undefined : repeats?.noteAfter(call.function.name, call.function.arguments, result);
            const text = safeText(result.text);
            const output = preview({ ok: result.ok, result: text });
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok: result.ok, output });
            if (!result.ok) { toolFailed = true; failedCalls.push(title); }
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, result: repeatNote ? `${text}\n\n${repeatNote}` : text }) });
            screenshotParts.push(...chatToolImages(call.id, result.images));
            abort.signal.throwIfAborted();
            if (fatal) throw fatal;
            if (repeats?.stopped) { stopReason = "incomplete_action"; throw new ChatProtocolError(repeats.stopped); }
          }
          if (screenshotParts.length) messages.push({ role: "user", content: screenshotParts });
        }
        if (!ok) throw new ChatProtocolError(stoppedAfter(`${MAX_CHAT_ROUNDS} steps`));
      } catch (value) {
        stopReason = abort.signal.aborted ? "interrupted" : stopReason ?? "error";
        failure = safeText(asError(value).message).slice(0, 2_000);
        failureText = runtimeErrorText(value);
      } finally {
        turnEntry.ending = true;
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
        if (!ok && (unread.length || turnEntry.asides.length)) emit({ ...base(turn.threadId, turnId), type: "runtime.notice", ...noticeFailure("chat.notice.unreadMessage") });
        if (failure && (!abort.signal.aborted || cleanupFailed)) {
          // "upstream" (an OpenAI-compatible URL) names no provider, and the Cloud trial credit reads its raw line.
          const words = options.httpErrorLabel === "upstream" ? { message: failure } : plainFailure(options.httpErrorLabel, failure);
          const replyShownFirst = stopReason === "tool_error";
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", ...words, ...(!cleanupFailed && failureText ? { text: failureText } : {}), terminal: !abort.signal.aborted, ...(replyShownFirst ? { partial: true } : {}) });
        }
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
      const down = await options.serverUnavailable?.();
      if (down) return { state: "unavailable", ...down };
      if (!options.apiKey) return { state: "unavailable", reason: options.unavailableReason };
      if (keyRejected(options.apiUrl, options.apiKey)) return { state: "available", authenticated: false, reason: KEY_REJECTED_REASON, version: null };
      return { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) };
    },
    adapter: {
      provider: options.driverKind,
      capabilities: { ...(options.computerUse ? { computerMcp: options.tools !== false,
        localComputerMcp: options.tools !== false,
        browserMcp: options.tools !== false, nativeImageInput: true, images: true } : {}),
        ...(options.modelVariants ? { modelVariants: true } : {}), sessionModelSwitch: "in-session", customMcp: options.tools !== false, agentsMcp: options.tools !== false, composioMcp: options.tools !== false,
        dataMcp: options.tools !== false,
        emailMcp: options.tools !== false,
        deviceMcp: options.tools !== false,
        queueing: true,
        ...(options.tools !== false ? { askTool: { kind: "native" as const, name: ASK_USER_TOOL } } : {}),
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
        const running = active.get(threadId);
        if (!running || running.ending) return "refused";
        running.asides.push(text);
        return "steered";
      },
      hasSession: (threadId) => active.has(threadId),
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
    generateText: async (prompt, { signal, onUsage, model: named } = {}) => {
      const model = named ?? options.generateModel?.() ?? options.models().default;
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false, signal, undefined, [], onUsage);
      if (toolCalls.length) throw new ChatProtocolError("provider returned tool calls to a text-only helper");
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      const turns = [...active.values()];
      for (const turn of turns) turn.abort.abort();
      await Promise.all(turns.map((turn) => turn.done));
      listeners.clear();
    },
  };
}
