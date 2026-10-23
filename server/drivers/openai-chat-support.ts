import { createHash } from "node:crypto";
import type { DriverCreateInput, ModelCatalog, SendTurnInput } from "../contracts.ts";





import { type ChatToolDefinition } from "./chat-mcp-tools.ts";
import { type ChatContentPart } from "./chat-images.ts";


import { ChatProtocolError, object, type ChatToolCall } from "./openai-chat-protocol.ts";





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

export interface CompletionJson {
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

 export function providerError(json: CompletionJson): string | null {
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

 export const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

 export function httpErrorDetail(body: string, limit = 500): string {
  let json: CompletionJson | undefined;
  try { json = object(JSON.parse(body)); } catch { json = undefined; }
  const message = json ? providerError(json) : null;
  if (!message || message === "unknown error") return body.slice(0, limit);
  const code = object(json?.error)?.code;
  const suffix = typeof code === "string" && MACHINE_CODE.test(code) ? ` (${code})` : "";
  return message.slice(0, limit) + suffix;
}

export interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

export interface WireHistory {
  model: string;
  system: string;
  volatile: string;
  catalogFingerprint: string;
  policy: string;
  /** The canonical selected branch represented by `messages`. */
  transcript: NonNullable<SendTurnInput["transcript"]>;
  transcriptOmitted: number;
  messages: OpenAIChatMessage[];
}

export const WIRE_HISTORY_MAX_THREADS = 8;
export const WIRE_HISTORY_MAX_MESSAGES = 96;
export const WIRE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

export function transcriptContinuation(
  actual: SendTurnInput["transcript"], previous: WireHistory,
): NonNullable<SendTurnInput["transcript"]> | null {
  const expected = previous.transcript;
  const { entries: selected, omitted } = selectedTranscript(actual);
  const offset = omitted - previous.transcriptOmitted;
  // The replay window may slide while this in-process history still holds
  // its earlier messages. Require an exact anchored suffix and the selector's
  // omission count; an unrelated or empty branch cannot inherit that history.
  if (offset < 0 || offset > expected.length || selected.length < expected.length - offset ||
      (offset > 0 && offset === expected.length)) return null;
  const overlap = selected.slice(0, expected.length - offset);
  if (offset > 0 && !overlap.some((entry, index) => Boolean(expected[offset + index]?.id) && entry.id === expected[offset + index]?.id)) return null;
  if (!overlap.every((entry, index) =>
    Boolean(entry.id) && (!expected[offset + index]?.id || entry.id === expected[offset + index]?.id) &&
    entry.role === expected[offset + index]?.role && entry.text === expected[offset + index]?.text)) return null;
  const appended = selected.slice(overlap.length);
  return appended.every((entry) => Boolean(entry.id)) ? appended : null;
}

export function selectedTranscript(actual: SendTurnInput["transcript"]): { entries: NonNullable<SendTurnInput["transcript"]>; omitted: number } {
  const first = actual?.[0];
  const marker = first?.id === "" && first.role === "assistant"
    ? /^\[([1-9]\d*) earlier messages omitted from this context; full history remains in the app\.\]$/.exec(first.text) : null;
  const omitted = marker ? Number(marker[1]) : 0;
  return Number.isSafeInteger(omitted) && omitted > 0
    ? { entries: actual!.slice(1), omitted } : { entries: actual ?? [], omitted: 0 };
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

export const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

export const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

export const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

export class ChatContextLimitError extends ChatProtocolError {}

/** Only a provider's definite input/context rejection permits a rebuild.
 * Generic invalid requests, output limits and authorization errors do not. */
export function contextLimitError(error: unknown): boolean {
  const detail = object(error);
  if (detail?.code === "context_length_exceeded") return true;
  const message = typeof error === "string" ? error : detail?.message;
  return typeof message === "string" && (
    /\b(?:request|input|prompt)\b.{0,100}\bexceeds?\b.{0,60}\b(?:context (?:size|length|window)|context limit)\b/i.test(message) ||
    /\bmaximum context length\b.{0,100}\b(?:requested|resulted in)\b/i.test(message)
  );
}

export function rejectsContextLimit(status: number, body: string): boolean {
  if (![400, 413, 422].includes(status)) return false;
  try { return contextLimitError(object(JSON.parse(body))?.error); } catch { return false; }
}

export class UnsupportedChatToolsError extends Error {}

 export const MAX_ANNOUNCEMENT_NUDGES = 3;
export const MAX_CHAT_ROUNDS = 64;
export const MAX_TURN_TOOL_CALLS = 200;
export const stoppedAfter = (count: string) =>
  `Stopped after ${count} without a final answer. The steps so far already ran, so ask only for what's left.`;

export interface DeliveredUserMessage {
  id?: string;
  text: string;
  sent: string;
  volatile?: string;
  after: string;
}

 export const MAX_REPLAY_EXTRA_BYTES = 24_000;
 export const MAX_DELIVERED_THREADS = 256;

export const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url");

 export function replayDelivered(
  transcript: ReadonlyArray<{ id?: string; role: "user" | "assistant"; text: string }>,
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
      if (record.id && record.id !== message.id) continue;
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

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

 export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && /^(?:let me|i['\u2019]ll|i will|i(?:['\u2019]m| am) going to)\s+(?:now\s+)?(?:execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify)\b/i.test(tail);
  }
  return /(?:[:\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i.test(reply) ||
    /^i(?:['\u2019]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}

export const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";
export const TEXT_ONLY_SCREENSHOT_NOTE = "[Screenshot not shown: this model cannot see images. Read the page with a snapshot or a text tool instead.]";

export function rejectsToolsParameter(status: number, body: string): boolean {
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

 export function rejectsReasoningReplay(status: number, body: string): boolean {
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

export const toolCallRefusal = (error: unknown) => {
  const body = object(error);
  return body?.code === "tool_use_failed" ? body : undefined;
};

export function refusedToolCall(status: number, body: string) {
  if (status !== 400) return undefined;
  try { return toolCallRefusal(object(JSON.parse(body))?.error); } catch { return undefined; }
}

export function completionError(json: CompletionJson, label: string): ChatProtocolError | null {
  const message = providerError(json);
  if (!message) return null;
  const text = `provider returned a ${label}: ${message.slice(0, 200)}`;
  if (contextLimitError(json.error)) return new ChatContextLimitError(text);
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
