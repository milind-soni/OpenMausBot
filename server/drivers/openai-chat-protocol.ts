// Structured chat-completions calls. Assistant content is never parsed as a tool.
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export const MAX_CHAT_TOOL_CALLS = 32;
const MAX_ARGUMENT_CHARS = 256_000;

export class ChatProtocolError extends Error {}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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
    if (this.chars > 256_000) throw new ChatProtocolError("provider reasoning details exceeded the size limit");
    this.blocks.push(...value);
  }
}

/** One accumulator per completion: indexes identify deltas; IDs correlate results. */
export class ChatToolCalls {
  private calls = new Map<number, ChatToolCall>();
  private argumentChars = 0;

  add(value: unknown, streaming: boolean): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) throw new ChatProtocolError("provider returned invalid tool_calls");
    for (const [position, raw] of value.entries()) {
      const delta = object(raw);
      const index = streaming ? delta?.index : position;
      if (!delta || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= MAX_CHAT_TOOL_CALLS) {
        throw new ChatProtocolError("provider returned an invalid tool-call index");
      }
      const call = this.calls.get(Number(index)) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (delta.type !== undefined && delta.type !== "function") throw new ChatProtocolError("unsupported tool-call type");
      if (delta.id !== undefined) {
        if (typeof delta.id !== "string" || !delta.id || delta.id.length > 256 || (call.id && call.id !== delta.id)) {
          throw new ChatProtocolError("provider changed or omitted a tool-call ID");
        }
        call.id = delta.id;
      }
      if (delta.function !== undefined) {
        const fn = object(delta.function);
        if (!fn) throw new ChatProtocolError("provider returned an invalid tool-call function");
        for (const field of ["name", "arguments"] as const) {
          if (fn[field] === undefined) continue;
          if (typeof fn[field] !== "string") throw new ChatProtocolError("provider returned invalid tool-call arguments or name");
          call.function[field] += fn[field];
          if (field === "arguments") this.argumentChars += fn[field].length;
        }
      }
      if (call.function.name.length > 64 || this.argumentChars > MAX_ARGUMENT_CHARS) {
        throw new ChatProtocolError("provider tool calls exceeded the size limit");
      }
      this.calls.set(Number(index), call);
    }
  }

  finish(reason: string | null, malformedFrame: boolean): ChatToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (malformedFrame) throw new ChatProtocolError("provider stream contained a malformed completion frame");
    if (reason === "function_call") throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
    if (reason === "tool_calls" && !calls.length) throw new ChatProtocolError("provider ended for tool calls without a complete call");
    if (!calls.length) return calls;
    if (reason !== null && reason !== "tool_calls" && reason !== "stop") {
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
