// ACP's session/request_permission carries a ToolCallUpdate: every field but toolCallId is optional and only changed
// fields are sent (Mistral Vibe 3.1.2 sends the toolCallId alone; Kimi Code 2.4.1 drops kind and rawInput). What the call
// is lives in its earlier tool_call and tool_call_update notifications.
// https://agentclientprotocol.com/protocol/tool-calls
const FIELDS = ["title", "kind", "rawInput", "locations", "content"] as const;
const MAX_CALLS = 256;

export type ToolCallFields = { [field in (typeof FIELDS)[number]]?: any };

/** One turn's tool calls by toolCallId, as their notifications left them. */
export class ToolCallDetails {
  private readonly calls = new Map<string, ToolCallFields>();

  /** A tool_call starts the call afresh; in a tool_call_update a field left out or null keeps its earlier value. */
  record(update: Record<string, any>, isNewCall = false): void {
    const id = update.toolCallId;
    if (typeof id !== "string" || !id) return;
    const known = isNewCall ? {} : this.calls.get(id) ?? {};
    this.calls.delete(id);
    for (const field of FIELDS) if (update[field] !== undefined && update[field] !== null) known[field] = update[field];
    this.calls.set(id, known);
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!);
  }

  /** The call as known so far, with the request's own fields over it. For the card's text, never its policy. */
  merged(toolCall: Record<string, any>): ToolCallFields {
    const known = typeof toolCall.toolCallId === "string" ? this.calls.get(toolCall.toolCallId) : undefined;
    const merged: ToolCallFields = { ...known };
    for (const field of FIELDS) if (toolCall[field] !== undefined && toolCall[field] !== null) merged[field] = toolCall[field];
    return merged;
  }
}
