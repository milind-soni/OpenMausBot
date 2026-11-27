import { prefixBytes } from "../context-rebuild.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { object } from "./openai-chat-protocol.ts";
import { RETRY_MAX_ATTEMPTS } from "./retry.ts";

/** nginx's "413 Request Entity Too Large" page, Express's "request entity too large", "Payload Too Large", and
 * OpenAI's "Request too large for <model>". */
const TOO_LARGE = /\b(?:request entity|payload|request) too large\b/i;
/** OpenAI's context_length_exceeded, and llama.cpp server's exceed_context_size_error (seen on b12532, streamed or not). */
const CONTEXT_REFUSALS: ReadonlySet<unknown> = new Set(["context_length_exceeded", "exceed_context_size_error"]);

const WINDOW_FILLED_BY_RESEND = 0.8;

function bodyError(body: string): Record<string, unknown> | undefined {
  try {
    return object(object(JSON.parse(body))?.error);
  } catch {
    return undefined;
  }
}

export function refusesRequestSize(status: number, body: string): boolean {
  if (status === 413 || TOO_LARGE.test(body)) return true;
  if (status !== 400) return false;
  const error = bodyError(body);
  return error?.code === "context_length_exceeded" || CONTEXT_REFUSALS.has(error?.type);
}

/** The share of a refused request that fits the window its provider counted (llama.cpp's n_ctx of n_prompt_tokens). */
export function shareThatFits(body: string): number | undefined {
  const error = bodyError(body);
  const window = error?.n_ctx, prompt = error?.n_prompt_tokens;
  if (typeof window !== "number" || typeof prompt !== "number" || window <= 0 || prompt < window) return undefined;
  return window / prompt * WINDOW_FILLED_BY_RESEND;
}

export class RequestTooLargeError extends Error {
  readonly bytes: number;
  readonly fits: number | undefined;
  constructor(message: string, bytes: number, fits?: number) {
    super(message);
    this.bytes = bytes;
    this.fits = fits;
  }
}

/** A provider that counts each refused request may be asked again with fresh counts, since bytes and its tokens differ
 * in proportion (an image, a dense prompt); a refusal that gives no count gets one smaller copy. */
export const resendsAllowed = (refusal: RequestTooLargeError): number => refusal.fits === undefined ? 1 : RETRY_MAX_ATTEMPTS - 1;

export const IMAGE_OMITTED = "[image omitted to fit the provider's size limit]";
export const TOOL_OUTPUT_SHORTENED = "\n[tool output shortened to fit the provider's size limit]";
export const TOOL_OUTPUT_OMITTED = "[earlier tool output omitted to fit the provider's size limit. The call already ran: do not repeat it to see this output; if you need what it did, check the current state first.]";
const omittedHistory = (count: number) =>
  `[${count} earlier message${count === 1 ? "" : "s"} omitted to fit the provider's size limit; full history remains in the app.]`;
const OMITTED_HISTORY = /^\[(\d+) earlier messages? omitted to fit the provider's size limit; full history remains in the app\.\]$/;
const omittedBefore = (message: OpenAIChatMessage): number | undefined => {
  const count = message.role === "assistant" && typeof message.content === "string" ? OMITTED_HISTORY.exec(message.content)?.[1] : undefined;
  return count === undefined ? undefined : Number(count);
};
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

function withToolOutput(message: OpenAIChatMessage, change: (text: string) => string): OpenAIChatMessage {
  const content = typeof message.content === "string" ? message.content : "";
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(content)); } catch { envelope = undefined; }
  return { ...message, content: typeof envelope?.result === "string" ? JSON.stringify({ ...envelope, result: change(envelope.result) }) : change(content) };
}

const shortenedToolOutput = (message: OpenAIChatMessage) =>
  withToolOutput(message, (text) => prefixBytes(text, SHORT_TOOL_OUTPUT_BYTES) + TOOL_OUTPUT_SHORTENED);
const omittedToolOutput = (message: OpenAIChatMessage) => withToolOutput(message, () => TOOL_OUTPUT_OMITTED);

/** Aims at `fits` of `refusedBytes`, half when the provider did not say: earlier history goes before this turn's own
 * older tool output, and the newest round is kept whole. Null when nothing else could shrink. */
export function smallerResend(
  messages: readonly OpenAIChatMessage[],
  request: OpenAIChatMessage,
  refusedBytes: number,
  fits = 0.5,
): { messages: OpenAIChatMessage[]; before: RequestSize; after: RequestSize } | null {
  const requestAt = messages.indexOf(request);
  if (requestAt < 0) throw new Error("the turn's request is not among the messages to resend");
  const before = requestSize(messages);
  const overhead = Math.max(0, refusedBytes - before.bytes);
  const target = Math.floor(refusedBytes * fits) - overhead;
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
  const latestCalls = messages.findLastIndex((message) => message.role === "assistant" && Boolean(message.tool_calls?.length));
  const steps = [
    ...shrinkable.filter((index) => imagesIn(messages[index]!)).map((index) => () => replace(index, withoutImages(out[index]!))),
    ...shrinkable.filter((index) => index > requestAt && messages[index]!.role === "tool" && sizes[index]! > LONG_TOOL_OUTPUT_BYTES)
      .map((index) => () => replace(index, shortenedToolOutput(out[index]!))),
    ...shrinkable.filter((index) => index < requestAt && omittedBefore(messages[index]!) === undefined).map((index) => () => replace(index, null)),
    ...shrinkable.filter((index) => index > requestAt && index < latestCalls && messages[index]!.role === "tool"
      && sizes[index]! > bytesOf(omittedToolOutput(messages[index]!))).map((index) => () => replace(index, omittedToolOutput(out[index]!))),
  ];
  let taken = 0;
  for (; taken < steps.length && total > target; taken++) steps[taken]!();
  if (!taken) return null;
  const earlier = messages.slice(0, requestAt);
  const notes = earlier.flatMap((message, index) => omittedBefore(message) === undefined ? [] : [index]);
  if (notes.length && earlier.some((_, index) => out[index] === null)) for (const index of notes) replace(index, null);
  const dropped = earlier.reduce((count, message, index) => out[index] === null ? count + (omittedBefore(message) ?? 1) : count, 0);
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
