
import type {
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
import { CHAT_TOOL_DISCOVERY_PROMPT, ChatToolSessionError, mountChatTools, type ChatToolDefinition, type ChatToolSession, type ChatToolResult } from "./chat-mcp-tools.ts";
import { assertImageTransport, chatImageBudget, chatToolImages, chatUserContent, type ChatContentPart } from "./chat-images.ts";
import { promptHalves, volatileContextNote, withContextNote } from "./prompt-split.ts";
import { createChatToolApproval, refusal } from "./chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object } from "./openai-chat-protocol.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { outOfCreditsMessage } from "./engine-errors.ts";
import { classifyContinuable, writeTurnHandoff } from "../turn-continuation.ts";
import { KEY_REJECTED_REASON, keyRejected, noteKeyAccepted, noteKeyRejected, rejectsKey } from "../key-rejections.ts";

import {
  type OpenAIChatMessage,
  type Usage,
  type Completion,
  type CompletionJson,
  httpErrorDetail,
  type WireHistory,
  WIRE_HISTORY_MAX_THREADS,
  WIRE_HISTORY_MAX_MESSAGES,
  WIRE_HISTORY_MAX_BYTES,
  transcriptContinuation,
  selectedTranscript,
  type RuntimeOptions,
  usageFrom,
  completionUsage,
  asError,
  ChatContextLimitError,
  rejectsContextLimit,
  UnsupportedChatToolsError,
  MAX_CHAT_ROUNDS,
  MAX_TURN_TOOL_CALLS,
  stoppedAfter,
  type DeliveredUserMessage,
  MAX_DELIVERED_THREADS,
  fingerprint,
  replayDelivered,
  NUDGE_ANNOUNCED_ACTION,
  announcesAction,
  TEXT_ONLY_ATTACHMENT_NOTE,
  TEXT_ONLY_SCREENSHOT_NOTE,
  rejectsToolsParameter,
  UnsupportedReasoningReplayError,
  rejectsReasoningReplay,
  RejectedToolCallError,
  refusedToolCall,
  completionError,
  refusedToolCallFailure,
} from "./openai-chat-support.ts";
export { type OpenAIChatMessage, announcesAction } from "./openai-chat-support.ts";
const CORRECTIVE_ROUND = "[OpenMausBot: a tool call in this turn failed (its result is marked ok:false). Re-run the failed operations with corrected inputs where possible, check the results, then give your final answer. Do not report results you did not get.]";

export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  // Retain complete protocol histories, including denied/failed tool results.
  // Incomplete replies cannot seed a prefix. Restarts and branch mismatches
  // use the durable bounded text transcript; raw results stay in memory.
  const wireHistory = new Map<string, WireHistory>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
    asides: string[];
  }>();
  const reasoningReplayRejected = new Set<string>();
  const delivered = new Map<string, { signature: string; records: DeliveredUserMessage[] }>();
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

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"],
    onProtocolOutput?: () => void,
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
        if (rejectsContextLimit(response.status, body)) throw new ChatContextLimitError(message);
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
        if (delta?.tool_calls || delta?.function_call || delta?.reasoning_details) onProtocolOutput?.();
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

  const seesImages = (turn: SendTurnInput) =>
    options.imageInput?.(turn.model || options.models().default) ?? true;
  const systemFor = (turn: SendTurnInput) => {
    const halves = promptHalves(turn);
    const system = halves.stable ?? turn.system ?? "";
    const integrations = turn.integrations;
    const hasMcp = Boolean(integrations?.agents || integrations?.composio || integrations?.data || integrations?.highlevel ||
      (options.computerUse && (integrations?.localComputer || integrations?.browser)) ||
      Object.keys(integrations?.custom ?? {}).length);
    return system + (options.tools === false || !hasMcp || system.endsWith(CHAT_TOOL_DISCOVERY_PROMPT) ? "" : CHAT_TOOL_DISCOVERY_PROMPT);
  };
  const policyFor = (turn: SendTurnInput) => JSON.stringify([
    turn.toolScope, turn.guestConfined, turn.confinedWhy,
    turn.cwd, turn.effort, turn.variant,
  ]);
  const messagesFor = (
    turn: SendTurnInput, catalogFingerprint: string, previous?: WireHistory,
    appended: NonNullable<SendTurnInput["transcript"]> = [],
  ): OpenAIChatMessage[] => {
    const halves = promptHalves(turn);
    const key = JSON.stringify([turn.botId ?? "", turn.threadId]);
    const signature = JSON.stringify([turn.model || options.models().default, systemFor(turn), policyFor(turn), catalogFingerprint]);
    const priorDelivered = delivered.get(key);
    const transcript = turn.transcript ?? [];
    const replay = replayDelivered(transcript, !turn.replayReset && priorDelivered?.signature === signature ? priorDelivered.records : []);
    const volatile = halves.volatile.trim();
    const priorVolatile = previous ? previous.volatile.trim() : replay.volatile;
    const note = halves.stable === null || (!turn.mentionTurn && priorVolatile === volatile) ? ""
      : volatileContextNote(halves.volatile, Boolean(priorVolatile));
    const userTurn = { ...turn, text: withContextNote(note, turn.text) };
    const textOnly = (value: string) => !options.computerUse || seesImages(turn) || !turn.images?.length ? value
      : `${value}\n\n${TEXT_ONLY_ATTACHMENT_NOTE}`;
    const current = { role: "user" as const, content: options.computerUse && seesImages(turn)
      ? chatUserContent(userTurn) : textOnly(userTurn.text) };
    {
      const kept = turn.recalled ? turn.text.replace(`${turn.recalled}\n\n`, "") : turn.text;
      // Re-anchor context in the bounded fallback: its earlier note may leave
      // the replay window while the complete wire prefix still retains it.
      const keptNote = previous ? volatileContextNote(halves.volatile, Boolean(previous.volatile.trim())) : note;
      const record = {
        ...(turn.sourceMessage?.id ? { id: turn.sourceMessage.id } : {}),
        text: kept, sent: textOnly(withContextNote(keptNote, kept)),
        ...(keptNote ? { volatile } : {}),
        after: transcript.length ? fingerprint(transcript.at(-1)!.text) : "",
      };
      delivered.delete(key);
      delivered.set(key, { signature, records: [...replay.matched, record] });
      if (delivered.size > MAX_DELIVERED_THREADS) delivered.delete(delivered.keys().next().value!);
    }
    if (previous) return [...previous.messages,
      ...appended.map((entry) => ({ role: entry.role, content: entry.text })), current];
    const system = systemFor(turn);
    return [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...transcript.map((message, index) => ({ role: message.role, content: replay.content.get(index) ?? message.text })),
      current,
    ];
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    if (options.computerUse && (turn.images?.length || turn.integrations?.localComputer || turn.integrations?.browser)) assertImageTransport(options.apiUrl);

    const turnId = newId();
    const abort = new AbortController();
    const model = turn.model || options.models().default;
    const halves = promptHalves(turn);
    const historyKey = JSON.stringify([turn.botId ?? "", turn.threadId]);
    const previous = wireHistory.get(historyKey);
    const appended = previous ? transcriptContinuation(turn.transcript, previous) : null;
    let reused = Boolean(previous && halves.stable !== null && previous.model === model &&
      previous.system === systemFor(turn) && previous.policy === policyFor(turn) &&
      appended !== null &&
      !turn.replayReset);
    let messages: OpenAIChatMessage[] = [];
    if (!reused) wireHistory.delete(historyKey);
    let retainImages = chatImageBudget();
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
      let correctiveRounds = 0;
      const denials: string[] = [];
      const seenCalls = new Set<string>();
      let nudged = false;
      let contextRebuilt = false;
      let responseOutput = false;
      let steered = false;
      let finalMessage: OpenAIChatMessage | undefined;
      const assistantTexts: string[] = [];
      try {
        const parsed = parseToolScope(turn.toolScope);
        if (!parsed.ok) throw new Error(parsed.error);
        const scope = parsed.scope;
        tools = await mountChatTools(options.tools === false ? undefined : turn.integrations, abort.signal, options.computerUse, scope, turn.mcpCallTimeoutMs);
        for (const { server, reason } of tools.skipped) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.notice", message: `MCP server "${server}" was skipped for this turn: ${safeText(reason)}` });
        }
        const questionAllowed = options.tools !== false && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL });
        let optionalQuestionOnly = questionAllowed && tools.definitions.length === 0;
        if (questionAllowed && !tools.definitions.some((definition) => definition.function.name === ASK_USER_TOOL)) {
          tools.definitions.push(ASK_USER_TOOL_DEFINITION);
        }
        const catalogFingerprint = tools.catalogFingerprint ?? JSON.stringify(tools.definitions);
        if (reused && previous?.catalogFingerprint !== catalogFingerprint) {
          reused = false;
          wireHistory.delete(historyKey);
          delivered.delete(historyKey);
        }
        messages = messagesFor(turn, catalogFingerprint, reused ? previous : undefined, reused ? appended! : []);
        for (const message of messages) retainImages(message.content);
        for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
          abort.signal.throwIfAborted();
          const parked = turnEntry.asides.splice(0);
          if (parked.length) {
            steered = true;
            messages.push({ role: "user", content: parked.join("\n\n") });
          }
          native("out", options.nativeLog.outgoing(turn, messages, model, tools.definitions));
          let attempt = 0;
          let completion: Completion;
          for (;;) {
            let streamed = false;
            let answerStreamed = false;
            const pending = { assistant_text: "", reasoning_text: "" };
            const delta = (text: string, streamKind: keyof typeof pending, flush = false) => {
              let combined = pending[streamKind] + text;
              for (const secret of secrets) if (secret) combined = combined.split(secret).join("[redacted]");
              let hold = 0;
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
                responseOutput = true;
                if (streamKind === "assistant_text") answerStreamed = true;
                delta(text, streamKind);
              }, tools.definitions, undefined, () => { responseOutput = true; });
              delta("", "assistant_text", true);
              delta("", "reasoning_text", true);
              break;
            } catch (value) {
              const error = asError(value);
              const verdict = classifyError(error);
              // A rejected reused prefix ran nothing in this turn. Rebuild
              // once from the canonical bounded transcript and current notes.
              // Parked input must not be discarded, and earlier output/tools
              // must never be replayed through this recovery.
              if (error instanceof ChatContextLimitError && reused && !contextRebuilt && round === 0 &&
                  !responseOutput && !seenCalls.size && !steered && !turnEntry.asides.length && !abort.signal.aborted) {
                contextRebuilt = true;
                reused = false;
                wireHistory.delete(historyKey);
                messages = messagesFor(turn, catalogFingerprint);
                // Only replacement messages remain retained; later screenshots
                // must share their fresh budget rather than the discarded one.
                retainImages = chatImageBudget();
                for (const message of messages) retainImages(message.content);
                native("out", options.nativeLog.outgoing(turn, messages, model, tools.definitions));
                continue;
              }
              if (error instanceof UnsupportedReasoningReplayError && !streamed && !abort.signal.aborted) {
                reasoningReplayRejected.add(model);
                for (const message of messages) delete message.reasoning_content;
                continue;
              }
              if (error instanceof RejectedToolCallError) {
                native("in", { refused: "tool_use_failed", attempt: attempt + 1, error: error.refusal });
                if (!answerStreamed && !abort.signal.aborted && attempt < RETRY_MAX_ATTEMPTS - 1) {
                  emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt: ++attempt, delayMs: 0, reason: "tool_use_failed" });
                  continue;
                }
                if (!abort.signal.aborted) throw new ChatProtocolError(refusedToolCallFailure(error, seenCalls.size > 0));
              }
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
            const contextWindow = options.models().options.find((entry) => entry.id === model)?.contextWindow;
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage,
              contextTokens: completion.usage.input + completion.usage.output,
              ...(contextWindow ? { contextWindow } : {}) });
          }
          // Reasoning on a tool-call round belongs to the protocol, not a final reply.
          const reply = completion.text.trim() ? completion.text : completion.toolCalls.length ? "" : completion.reasoning;
          if (reply.trim()) {
            assistantTexts.push(safeText(reply));
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply) });
          }
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
            finalMessage = {
              role: "assistant", content: completion.text || null,
              ...(completion.protocolReasoning && !reasoningReplayRejected.has(model)
                ? { [options.reasoningReplayField ?? "reasoning_content"]: completion.protocolReasoning } : {}),
              ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
            };
            if (toolFailed) {
              // A person's "no" is never answered with another attempt; a failure may first get the configured corrective rounds.
              if (!denials.length && correctiveRounds < (turn.toolErrorCorrectiveRounds ?? 0)) {
                correctiveRounds += 1;
                messages.push(finalMessage, { role: "user", content: CORRECTIVE_ROUND });
                finalMessage = undefined;
                continue;
              }
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
          if (seenCalls.size > MAX_TURN_TOOL_CALLS) throw new ChatProtocolError(stoppedAfter(`${MAX_TURN_TOOL_CALLS} tool calls`));
          messages.push({ role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls,
            ...(completion.protocolReasoning && !reasoningReplayRejected.has(model) ? { [options.reasoningReplayField ?? "reasoning_content"]: completion.protocolReasoning } : {}),
            ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
          });
          // After a corrective round, the failure stays pending only until the bot runs tools again.
          if (correctiveRounds && !denials.length) toolFailed = false;
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
                tools.validate(call.function.name, args);
                const shown = tools.view(call.function.name, args as Record<string, unknown>);
                const shownPreview = shown.input === args ? inputPreview : preview(shown.input);
                // This runtime has no provider reviewer, so Full access is honoured here.
                const floored = approval.floored({ full: turn.approvalMode === "full", threadId: turn.threadId, botId: turn.botId, shown, summary: shownPreview });
                const allowed = !floored && (turn.approvalMode === "full" || !shown.ask
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
        if (!finalMessage || cleanupFailed || abort.signal.aborted || steered) delivered.delete(historyKey);
        const selected = selectedTranscript(turn.transcript);
        if (finalMessage && !cleanupFailed && !abort.signal.aborted && turn.sourceMessage?.id && turn.sourceMessage.text &&
            (reused || selected.entries.every((entry) => Boolean(entry.id))) && !steered) {
          const transcript = [...(reused && previous ? [...previous.transcript, ...appended!] : selected.entries), turn.sourceMessage,
            ...assistantTexts.map((text) => ({ role: "assistant" as const, text }))];
          const nextMessages = [...messages, finalMessage];
          if (nextMessages.length <= WIRE_HISTORY_MAX_MESSAGES &&
              Buffer.byteLength(JSON.stringify(nextMessages), "utf8") <= WIRE_HISTORY_MAX_BYTES) {
            wireHistory.delete(historyKey);
            wireHistory.set(historyKey, {
              model, system: systemFor(turn), volatile: halves.volatile,
              policy: policyFor(turn),
              catalogFingerprint: tools?.catalogFingerprint ?? JSON.stringify(tools?.definitions ?? []), transcript,
              transcriptOmitted: reused && previous ? previous.transcriptOmitted : selected.omitted,
              messages: nextMessages,
            });
            while (wireHistory.size > WIRE_HISTORY_MAX_THREADS) wireHistory.delete(wireHistory.keys().next().value!);
          } else wireHistory.delete(historyKey);
        } else wireHistory.delete(historyKey);
        if (failure && (!abort.signal.aborted || cleanupFailed)) {
          // "upstream" (an OpenAI-compatible URL) names no provider, and the Cloud trial credit reads its raw line.
          const message = options.httpErrorLabel === "upstream" ? failure : outOfCreditsMessage(options.httpErrorLabel, failure);
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message, terminal: !abort.signal.aborted });
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
      if (!options.apiKey) return { state: "unavailable", reason: options.unavailableReason };
      if (keyRejected(options.apiUrl, options.apiKey)) return { state: "available", authenticated: false, reason: KEY_REJECTED_REASON, version: null };
      return { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) };
    },
    adapter: {
      provider: options.driverKind,
      systemPromptSuffix: options.tools === false ? "" : CHAT_TOOL_DISCOVERY_PROMPT,
      capabilities: { ...(options.computerUse ? { computerMcp: options.tools !== false,
        localComputerMcp: options.tools !== false,
        browserMcp: options.tools !== false, nativeImageInput: true, images: true } : {}),
        sessionModelSwitch: "in-session", customMcp: options.tools !== false, agentsMcp: options.tools !== false, composioMcp: options.tools !== false,
        dataMcp: options.tools !== false,
        highlevelMcp: options.tools !== false,
        queueing: true,
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
        if (!running) return "refused";
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
      wireHistory.clear();
      delivered.clear();
      listeners.clear();
    },
  };
}
