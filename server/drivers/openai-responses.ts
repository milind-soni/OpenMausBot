// OpenAI's Responses API, for the models that refuse function tools over Chat Completions. The turn keeps its
// Chat-shaped messages; this file translates them on the way out and reads the event stream on the way in.
// https://developers.openai.com/api/docs/guides/migrate-to-responses
import type { Completion, OpenAIChatMessage } from "./openai-chat.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import { ChatProtocolError, ChatToolCalls, object } from "./openai-chat-protocol.ts";

export type ResponseItem = Record<string, unknown>;

/** `chat-reasoning-off` is Chat Completions with `reasoning_effort: "none"`, which the refusal itself offers. */
export type ModelRoute = "chat" | "responses" | "chat-reasoning-off";
export type RouteRefusal = "tools-need-responses" | "responses-unavailable" | "summaries-refused";

export class ModelRouteRefused extends Error {
  readonly refusal: RouteRefusal;
  constructor(refusal: RouteRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

export function noRouteLeft(provider: string): string {
  return `This model can only use tools through OpenAI's Responses API, and this API address or key can't reach it. Choose another model. Provider: ${provider.slice(0, 300)}`;
}

export function isOpenAIAddress(apiUrl: string): boolean {
  let url: URL;
  try { url = new URL(apiUrl); } catch { return false; }
  const own = url.hostname === "api.openai.com" || url.hostname.endsWith(".api.openai.com");
  return own && url.protocol === "https:" && url.pathname.replace(/\/+$/, "") === "/v1";
}

/** Each model only moves forward, so a resend can never loop. OpenAI's own address serves Responses; another address
 * may not, so it keeps Chat Completions while reasoning off works there and tries Responses only when that is refused.
 * A call without tools never meets the refusal and stays on Chat Completions. */
export function createModelRoutes(apiUrl: string) {
  const order: readonly ModelRoute[] = isOpenAIAddress(apiUrl)
    ? ["chat", "responses", "chat-reasoning-off"]
    : ["chat", "chat-reasoning-off", "responses"];
  const routes = new Map<string, ModelRoute>();
  const noSummaries = new Set<string>();
  return {
    routeFor: (model: string, hasTools: boolean): ModelRoute => hasTools ? routes.get(model) ?? "chat" : "chat",
    summaries: (model: string) => !noSummaries.has(model),
    /** False when the model has nothing left to try. */
    advance(model: string, refusal: RouteRefusal): boolean {
      const route = routes.get(model) ?? "chat";
      if (refusal === "summaries-refused") {
        if (noSummaries.has(model)) return false;
        noSummaries.add(model);
        return true;
      }
      const next = order[order.indexOf(route) + 1];
      if (!next || refusal !== (route === "responses" ? "responses-unavailable" : "tools-need-responses")) return false;
      routes.set(model, next);
      return true;
    },
  };
}

function errorIn(body: string): Record<string, unknown> | undefined {
  try { return object(object(JSON.parse(body))?.error); } catch { return undefined; }
}

/** The answer that moves a model to another route, read from what the provider said rather than from a list of models. */
export function routeRefusal(route: ModelRoute, status: number, body: string): RouteRefusal | null {
  if (route !== "responses") {
    // "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function
    // tools, use /v1/responses or set reasoning_effort to 'none'." A relay may wrap it, so the whole body is read.
    if (status !== 400 && status !== 422) return null;
    if (/\bv1\/responses\b/i.test(body) && /\breasoning_effort\b/i.test(body)) return "tools-need-responses";
    return route === "chat-reasoning-off" && /\breasoning[._]effort\b|'none'/i.test(body) ? "tools-need-responses" : null;
  }
  const error = errorIn(body);
  const message = typeof error?.message === "string" ? error.message : "";
  // Summaries need a verified organization: https://developers.openai.com/api/docs/guides/reasoning
  if (status === 400 && (error?.param === "reasoning.summary" || /\breasoning summar/i.test(message))) return "summaries-refused";
  if (status === 404 || status === 405) return error?.code === "model_not_found" ? null : "responses-unavailable";
  // A restricted key may hold Chat Completions but not `api.responses.write`; the key itself is fine.
  if ((status === 401 || status === 403) && /\bmissing scopes?\b/i.test(message)) return "responses-unavailable";
  return null;
}

function inputContent(content: ChatContentPart[]) {
  return content.map((part) => part.type === "image_url"
    ? { type: "input_image", image_url: part.image_url.url, detail: "auto" }
    : { type: "input_text", text: part.text });
}

function inputItems(message: OpenAIChatMessage, replay: ResponseItem[] | undefined): ResponseItem[] {
  if (message.role === "system") return [];
  // A stateless reasoning model needs every output item back untouched, its reasoning and assistant `phase` included:
  // https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context
  if (replay) return replay;
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }];
  }
  const said = Array.isArray(message.content) ? inputContent(message.content) : message.content;
  return [
    ...(said ? [{ role: message.role, content: said }] : []),
    ...(message.tool_calls ?? []).map((call) => ({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
  ];
}

/** `store: false` keeps a turn on OpenAI's side no longer than Chat Completions would, and returns reasoning encrypted.
 * Omitting `strict` would let Responses rewrite each tool's schema into strict mode, where optional arguments become
 * required; Chat Completions is non-strict, and the tools validate against their own schemas. */
export function responsesRequest(input: {
  model: string;
  messages: readonly OpenAIChatMessage[];
  tools: readonly ChatToolDefinition[];
  replay: (message: OpenAIChatMessage) => ResponseItem[] | undefined;
  summaries: boolean;
}): Record<string, unknown> {
  const instructions = input.messages.filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content).join("\n\n");
  return {
    model: input.model,
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    input: input.messages.flatMap((message) => inputItems(message, input.replay(message))),
    ...(input.summaries ? { reasoning: { summary: "auto" } } : {}),
    tools: input.tools.map(({ function: { name, description, parameters } }) => ({ type: "function", name, description, parameters, strict: false })),
  };
}

const FAILURE_STATUS: Record<string, number> = { rate_limit_exceeded: 429, server_error: 500 };
/** `response.created` and `response.completed` echo the request's instructions and tools. */
const MAX_FRAME_CHARS = 16_000_000;

function partsText(parts: unknown, ...fields: string[]): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    const row = object(part);
    return fields.map((field) => row?.[field]).find((value) => typeof value === "string") ?? "";
  }).join("");
}

/** `response.failed` and `error` answer with HTTP 200 what Chat Completions answers with a status, so `fail` reads them
 * the same way. */
export async function readResponsesStream(body: ReadableStream<Uint8Array> | null, handlers: {
  reasoning: boolean;
  onBytes(): void;
  onDelta(delta: string, kind: "assistant_text" | "reasoning_text"): void;
  fail(status: number, body: string): Error;
}): Promise<Completion> {
  if (!body) throw new ChatProtocolError("OpenAI returned no response body");
  let text = "";
  let reasoning = "";
  let lastTextItem: unknown;
  let lastSummaryPart: string | undefined;
  let finishReason: string | null = null;
  let usage: Completion["usage"] = null;
  const streamed = new Set<unknown>();
  const done = new Map<number, ResponseItem>();
  const calls = new ChatToolCalls();
  let callCount = 0;

  const say = (delta: string, item: unknown) => {
    if (!delta) return;
    const piece = (text && item !== lastTextItem ? "\n\n" : "") + delta;
    lastTextItem = item;
    text += piece;
    handlers.onDelta(piece, "assistant_text");
  };
  const think = (delta: string, part: string) => {
    if (!delta || !handlers.reasoning) return;
    const piece = (reasoning && part !== lastSummaryPart ? "\n\n" : "") + delta;
    lastSummaryPart = part;
    reasoning += piece;
    handlers.onDelta(piece, "reasoning_text");
  };
  const finishItem = (item: ResponseItem, position: number) => {
    done.set(position, item);
    if (item.type === "function_call") {
      calls.add([{ index: callCount++, id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }], true);
    } else if (item.type === "message" && !streamed.has(item.id)) {
      say(partsText(item.content, "text", "refusal"), item.id);
    } else if (item.type === "reasoning" && !streamed.has(item.id)) {
      think(partsText(item.summary, "text"), `${String(item.id)}:0`);
    }
  };
  const finish = (response: Record<string, unknown> | undefined) => {
    if (!done.size && Array.isArray(response?.output)) {
      for (const [position, item] of response.output.entries()) if (object(item)) finishItem(item as ResponseItem, position);
    }
    const used = object(response?.usage);
    if (used) usage = { input: Number(used.input_tokens) || 0, output: Number(used.output_tokens) || 0 };
  };
  const failure = (error: Record<string, unknown> | undefined) => {
    const code = typeof error?.code === "string" ? error.code : "";
    return handlers.fail(FAILURE_STATUS[code] ?? 400, JSON.stringify({ error: error ?? { message: "unknown error" } }));
  };

  const consume = (event: Record<string, unknown>): boolean => {
    const delta = typeof event.delta === "string" ? event.delta : "";
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        streamed.add(event.item_id);
        say(delta, event.item_id);
        return false;
      case "response.reasoning_summary_text.delta":
        streamed.add(event.item_id);
        think(delta, `${String(event.item_id)}:${String(event.summary_index)}`);
        return false;
      case "response.output_item.done": {
        const item = object(event.item);
        if (item) finishItem(item, typeof event.output_index === "number" ? event.output_index : done.size);
        return false;
      }
      case "response.completed":
        finish(object(event.response));
        finishReason = callCount ? "tool_calls" : "stop";
        return true;
      case "response.incomplete": {
        const response = object(event.response);
        finish(response);
        const reason = object(response?.incomplete_details)?.reason;
        finishReason = reason === "max_output_tokens" ? "length" : typeof reason === "string" ? reason : "incomplete";
        return true;
      }
      case "response.failed":
        throw failure(object(object(event.response)?.error));
      case "error":
        throw failure(event);
      default:
        return false;
    }
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  try {
    while (!ended) {
      const { done: closed, value } = await reader.read();
      if (closed) throw new ChatProtocolError("Stream ended before completion");
      handlers.onBytes();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_FRAME_CHARS) throw new ChatProtocolError("provider stream frame exceeded the size limit");
      let newline: number;
      while (!ended && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        let event: Record<string, unknown> | undefined;
        try { event = object(JSON.parse(line.slice(5).trim())); }
        catch { throw new ChatProtocolError("provider stream contained a malformed event"); }
        if (event) ended = consume(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return {
    text, reasoning, usage, finishReason,
    toolCalls: calls.finish(finishReason, false),
    protocolReasoning: "",
    protocolReasoningDetails: [],
    responseOutput: [...done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
  };
}
