import { prefixBytes } from "../context-rebuild.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { object } from "./openai-chat-protocol.ts";

/** nginx's "413 Request Entity Too Large" page, Express's "request entity too large", "Payload Too Large", and
 * OpenAI's "Request too large for <model>". */
const TOO_LARGE = /\b(?:request entity|payload|request) too large\b/i;

export function refusesRequestSize(status: number, body: string): boolean {
  return status === 413 || TOO_LARGE.test(body);
}

export class RequestTooLargeError extends Error {
  readonly bytes: number;
  constructor(message: string, bytes: number) {
    super(message);
    this.bytes = bytes;
  }
}

export const IMAGE_OMITTED = "[image omitted to fit the provider's size limit]";
export const TOOL_OUTPUT_SHORTENED = "\n[tool output shortened to fit the provider's size limit]";
const omittedHistory = (count: number) =>
  `[${count} earlier message${count === 1 ? "" : "s"} omitted to fit the provider's size limit; full history remains in the app.]`;
const LONG_TOOL_OUTPUT_BYTES = 4_000;
const SHORT_TOOL_OUTPUT_BYTES = 1_000;

export interface RequestSize {
  bytes: number;
  messages: number;
  images: number;
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isImage = (part: ChatContentPart) => part.type === "image_url";
const imagesIn = (message: OpenAIChatMessage) => Array.isArray(message.content) ? message.content.filter(isImage).length : 0;

export function requestSize(messages: readonly OpenAIChatMessage[], overheadBytes = 0): RequestSize {
  return {
    bytes: bytesOf(messages) + overheadBytes,
    messages: messages.length,
    images: messages.reduce((total, message) => total + imagesIn(message), 0),
  };
}

function withoutImages(message: OpenAIChatMessage): OpenAIChatMessage {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((part) => isImage(part) ? { type: "text" as const, text: IMAGE_OMITTED } : part) };
}

function shortenedToolOutput(message: OpenAIChatMessage): OpenAIChatMessage {
  const content = typeof message.content === "string" ? message.content : "";
  const shorten = (text: string) => prefixBytes(text, SHORT_TOOL_OUTPUT_BYTES) + TOOL_OUTPUT_SHORTENED;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(content)); } catch { envelope = undefined; }
  return { ...message, content: typeof envelope?.result === "string" ? JSON.stringify({ ...envelope, result: shorten(envelope.result) }) : shorten(content) };
}

/** Aims at half of `refusedBytes`; null when nothing but the system prompt and `request` could shrink. */
export function smallerResend(
  messages: readonly OpenAIChatMessage[],
  request: OpenAIChatMessage,
  refusedBytes: number,
): { messages: OpenAIChatMessage[]; before: RequestSize; after: RequestSize } | null {
  const requestAt = messages.indexOf(request);
  if (requestAt < 0) throw new Error("the turn's request is not among the messages to resend");
  const before = requestSize(messages);
  const overhead = Math.max(0, refusedBytes - before.bytes);
  const target = Math.floor(refusedBytes / 2) - overhead;
  const out: Array<OpenAIChatMessage | null> = [...messages];
  const sizes = out.map(bytesOf);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const replace = (index: number, next: OpenAIChatMessage | null) => {
    const size = next ? bytesOf(next) : 0;
    total += size - sizes[index]!;
    sizes[index] = size;
    out[index] = next;
  };
  const shrinkable = messages.flatMap((message, index) => index === requestAt || message.role === "system" ? [] : [index]);
  const steps = [
    ...shrinkable.filter((index) => imagesIn(messages[index]!)).map((index) => () => replace(index, withoutImages(out[index]!))),
    ...shrinkable.filter((index) => index > requestAt && messages[index]!.role === "tool" && sizes[index]! > LONG_TOOL_OUTPUT_BYTES)
      .map((index) => () => replace(index, shortenedToolOutput(out[index]!))),
    ...shrinkable.filter((index) => index < requestAt).map((index) => () => replace(index, null)),
  ];
  let taken = 0;
  for (; taken < steps.length && total > target; taken++) steps[taken]!();
  if (!taken) return null;
  const dropped = out.slice(0, requestAt).filter((message) => message === null).length;
  const firstDropped = out.indexOf(null);
  const kept = out.flatMap((message, index) => [
    ...(dropped && index === firstDropped ? [{ role: "assistant" as const, content: omittedHistory(dropped) }] : []),
    ...(message ? [message] : []),
  ]);
  return { messages: kept, before: { ...before, bytes: refusedBytes }, after: requestSize(kept, overhead) };
}

export function sizeChange(before: RequestSize, after: RequestSize): string {
  return `${before.bytes} → ${after.bytes} bytes, ${before.messages} → ${after.messages} messages, ${before.images} → ${after.images} images`;
}
