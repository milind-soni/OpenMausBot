// Structured chat-completions calls. Assistant content becomes a tool call only for a local model, in chat-text-tool-calls.ts.
import { randomUUID } from "node:crypto";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini's thought signature (`{ google: { thought_signature } }`): sent back with the call, or Gemini rejects the
   * next round with "Function call is missing a thought_signature". */
  extra_content?: Record<string, unknown>;
}

/** Calls one model reply may carry (its index bound). */
const MAX_REPLY_TOOL_CALLS = 32;
const MAX_ARGUMENT_CHARS = 256_000;
/** One completion's reasoning blocks, as JSON. Streamed blocks repeat their type/format/index on every delta, so this
 * counts many times the reasoning text itself; a long tool chain on a reasoning model can pass 256 KB. */
export const MAX_REASONING_DETAIL_CHARS = 4_000_000;

export class ChatProtocolError extends Error {}

export const CUT_REPLY_NOTE = "[OpenMausBot: your reply was cut at the output limit. Continue exactly where you stopped.]";
/** Continuations per turn, shared by every reply the turn produces, so one turn cannot bill forever. */
const MAX_LENGTH_CONTINUATIONS = 8;

/** Null when the completion is not a cut reply that can be continued; `exhausted` when the turn's budget is spent. A
 * local model writes tool calls as text, so a cut reply there may be half a call and stays a failure. */
function cutReplyOutcome(state: { count: number }, completion: { finishReason: string | null; text: string }, localTools: boolean): "continue" | "exhausted" | null {
  if (completion.finishReason !== "length" || !completion.text.trim() || localTools) return null;
  return state.count < MAX_LENGTH_CONTINUATIONS ? "continue" : "exhausted";
}

/** True when a cut reply has a continuation left in this turn's budget. */
export function cutReplyWillContinue(state: { count: number }, completion: { finishReason: string | null; text: string }, localTools: boolean): boolean {
  return cutReplyOutcome(state, completion, localTools) === "continue";
}

/** True when a cut reply should be continued and consumes one continuation; throws once the turn's budget is spent. */
export function cutReplyContinues(state: { count: number }, completion: { finishReason: string | null; text: string }, localTools: boolean): boolean {
  const outcome = cutReplyOutcome(state, completion, localTools);
  if (outcome === "exhausted") {
    throw new ChatProtocolError(`The reply was still cut at the output limit after ${MAX_LENGTH_CONTINUATIONS} continuations; the turn was stopped.`);
  }
  if (!outcome) return false;
  state.count += 1;
  return true;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** A call's arguments as its tool gets them. An empty argument string is a tool with no arguments. `redact` masks
 * secrets in rejected arguments before they are cut down to quote, so a secret split by the cut can't slip past it. */
export function toolArguments(text: string, redact: (text: string) => string = (same) => same): Record<string, unknown> {
  let args: unknown;
  try { args = JSON.parse(text.trim() || "{}"); }
  catch { throw new ChatProtocolError(`tool arguments are not complete JSON; you sent ${text.length} characters: ${shownArguments(redact(text))}`); }
  const found = object(args);
  if (!found) throw new ChatProtocolError(`tool arguments must be a JSON object; you sent ${text.length} characters: ${shownArguments(redact(text))}`);
  return found;
}

/** Rejected arguments as the failed call's result quotes them back, so the model sees where they broke off. */
function shownArguments(text: string): string {
  return text.length <= 1_000 ? text : `${text.slice(0, 500)} … ${text.slice(-500)}`;
}

/** The calls as the next request replays them. A strict server refuses the whole request over arguments that don't
 * parse ("function.arguments must be valid JSON"), so blank ones (a tool with no arguments) and ones `toolArguments`
 * refuses (they never ran; the call's result says so) go back as `{}`, and ones that ran only once trimmed (a stray
 * byte-order mark, which isn't JSON whitespace) go back trimmed. */
export function replayableToolCalls(calls: ChatToolCall[]): ChatToolCall[] {
  return calls.map((call) => {
    const replayed = replayArguments(call.function.arguments);
    return replayed === call.function.arguments ? call : { ...call, function: { ...call.function, arguments: replayed } };
  });
}

function replayArguments(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "{}";
  try { toolArguments(trimmed); return trimmed; } catch { return "{}"; }
}

/** Opaque provider reasoning blocks must keep their original order/signatures.
 * OpenRouter streams the sequence as arrays of blocks, not tool-call deltas. */
export class ChatReasoningDetails {
  readonly blocks: Record<string, unknown>[] = [];
  private chars = 0;

  add(value: unknown): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.some((block) => !object(block))) {
      throw new ChatProtocolError("provider returned invalid reasoning details");
    }
    this.chars += JSON.stringify(value).length;
    if (this.chars > MAX_REASONING_DETAIL_CHARS) throw new ChatProtocolError("provider reasoning details exceeded the size limit");
    // One push per block: spreading a huge array into push() can pass the engine's argument limit.
    for (const block of value) this.blocks.push(block);
  }
}

/** One accumulator per completion: indexes identify deltas; IDs correlate results. */
export class ChatToolCalls {
  private calls = new Map<number, ChatToolCall>();
  private argumentChars = 0;
  /** The pre-tools `function_call` field some OpenAI-compatible relays still answer with: one call, no ID. */
  private legacy = { name: "", arguments: "" };
  /** Why the legacy call can't be used; reported only when it is the reply's call, so a mirror can't reject tool_calls. */
  private legacyError = "";

  addLegacy(value: unknown): void {
    if (value === undefined || value === null || this.legacyError) return;
    const fn = object(value);
    if (!fn) {
      this.legacyError = "provider returned an invalid function_call";
      return;
    }
    for (const field of ["name", "arguments"] as const) {
      if (fn[field] === undefined || fn[field] === null) continue;
      if (typeof fn[field] !== "string") {
        this.legacyError = "provider returned invalid function_call arguments or name";
        return;
      }
      this.legacy[field] += fn[field];
    }
    if (this.legacy.name.length > 64 || this.legacy.arguments.length > MAX_ARGUMENT_CHARS) {
      this.legacyError = "provider tool calls exceeded the size limit";
      this.legacy = { name: "", arguments: "" };
    }
  }

  add(value: unknown, streaming: boolean): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) throw new ChatProtocolError("provider returned invalid tool_calls");
    // Streamed continuation chunks may repeat a field as null, or as "" (DashScope/Qwen sends the id only on a call's
    // first chunk).
    const omitted = (field: unknown) => field === undefined || (streaming && (field === null || field === ""));
    for (const [position, raw] of value.entries()) {
      const delta = object(raw);
      const index = !streaming ? position : delta?.index ?? this.slotOf(delta?.id);
      if (!delta || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= MAX_REPLY_TOOL_CALLS) {
        throw new ChatProtocolError("provider returned an invalid tool-call index");
      }
      const call = this.calls.get(Number(index)) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (!omitted(delta.type) && delta.type !== "function") throw new ChatProtocolError("unsupported tool-call type");
      if (!omitted(delta.id)) {
        if (typeof delta.id !== "string" || !delta.id || delta.id.length > 256 || (call.id && call.id !== delta.id)) {
          throw new ChatProtocolError("provider changed or omitted a tool-call ID");
        }
        call.id = delta.id;
      }
      if (delta.function !== undefined) {
        const fn = object(delta.function);
        if (!fn) throw new ChatProtocolError("provider returned an invalid tool-call function");
        for (const field of ["name", "arguments"] as const) {
          if (omitted(fn[field])) continue;
          if (typeof fn[field] !== "string") throw new ChatProtocolError("provider returned invalid tool-call arguments or name");
          call.function[field] += fn[field];
          if (field === "arguments") this.argumentChars += fn[field].length;
        }
      }
      const extra = object(delta.extra_content);
      if (extra) {
        // A later chunk replaces the earlier value, so count only the size change.
        const previous = call.extra_content ? JSON.stringify(call.extra_content).length : 0;
        call.extra_content = extra;
        this.argumentChars += JSON.stringify(extra).length - previous;
      }
      if (call.function.name.length > 64 || this.argumentChars > MAX_ARGUMENT_CHARS) {
        throw new ChatProtocolError("provider tool calls exceeded the size limit");
      }
      this.calls.set(Number(index), call);
    }
  }

  /** Gemini's OpenAI-compatible endpoint streams each call whole, with an id and no index: the slot of the call with
   * that id, else the one after the last. */
  private slotOf(id: unknown): number | undefined {
    if (typeof id !== "string" || !id) return undefined;
    for (const [slot, call] of this.calls) if (call.id === id) return slot;
    return this.calls.size ? Math.max(...this.calls.keys()) + 1 : 0;
  }

  finish(reason: string | null, malformedFrame: boolean): ChatToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (malformedFrame) throw new ChatProtocolError("provider stream contained a malformed completion frame");
    // A legacy call counts only alone: relays that mirror tool_calls or send an empty placeholder add nothing.
    if (!calls.length) {
      if (this.legacyError) throw new ChatProtocolError(this.legacyError);
      if (this.legacy.name) {
        calls.push({ id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { ...this.legacy } });
      } else if (this.legacy.arguments) {
        throw new ChatProtocolError("provider ended for tool calls without a complete call");
      }
    }
    if ((reason === "tool_calls" || reason === "function_call") && !calls.length) {
      throw new ChatProtocolError("provider ended for tool calls without a complete call");
    }
    if (!calls.length) return calls;
    if (reason !== null && reason !== "tool_calls" && reason !== "function_call" && reason !== "stop") {
      throw new ChatProtocolError("provider tool calls were truncated or malformed");
    }
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.id || ids.has(call.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(call.function.name)) {
        throw new ChatProtocolError("provider returned an incomplete or duplicate tool call");
      }
      ids.add(call.id);
    }
    return calls;
  }
}
