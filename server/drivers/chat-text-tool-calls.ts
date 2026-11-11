// A tool call a local model wrote as text instead of as a structured call. Local servers turn this text into tool_calls
// only when their chat template and parser match the model, and when they do not the call reaches us as the reply: Qwen
// through Ollama's /v1, a GGUF with a stock template, a server started without --jinja.
//
// The forms are the ones the servers' own parsers read: `<tool_call>{json}</tool_call>` (Hermes and Qwen templates),
// `<function=name><parameter=key>…` (Qwen coder templates) and a reply that is nothing but one JSON call. This is stricter
// than those parsers, which take a tag anywhere in the output: the calls must end the reply and name an offered tool, so
// a reply that quotes a call and goes on talking stays a reply. Reasoning is never read. A recovered call then takes the
// same schema check and approval as any other.
import { randomUUID } from "node:crypto";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import { object } from "./openai-chat-protocol.ts";

export interface OfferedTool {
  function: { name: string; parameters?: Record<string, unknown> };
}

export type TextToolCalls =
  /** `text` is what the model said before the calls. */
  | { kind: "calls"; calls: ChatToolCall[]; text: string }
  /** It tried to call a tool and the call cannot be read: worth one request to send it again. */
  | { kind: "unreadable"; text: string };

const MAX_CALLS = 32;
const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const OPEN_FUNCTION = "<function=";
const THINK_END = "</think>";

const FUNCTION_BLOCK = /<function=([^>\s]+)\s*>([\s\S]*?)(?:<\/function>|$)/;
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;
const FENCED_JSON = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

function parsedObject(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

function declaredType(tool: OfferedTool, key: string): unknown {
  return object(object(tool.function.parameters?.properties)?.[key])?.type;
}

/** A parameter's body is text; the tool's schema says when it is a number, an object or a list. */
function parameterValue(tool: OfferedTool, key: string, raw: string): unknown {
  const value = raw.replace(/^\n/, "").replace(/\n$/, "");
  const type = declaredType(tool, key);
  if (type === "string" || (Array.isArray(type) && type.includes("string"))) return value;
  try { return JSON.parse(value.trim()); } catch { return value; }
}

function toCall(name: string, args: Record<string, unknown>): ChatToolCall {
  return { id: `text_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function jsonCall(body: string, offered: ReadonlyMap<string, OfferedTool>): ChatToolCall | undefined {
  const parsed = parsedObject(body);
  if (typeof parsed?.name !== "string" || !offered.has(parsed.name)) return undefined;
  // Llama-family templates write `parameters`; an argument object some models double-encode is still that object.
  const raw = parsed.arguments ?? parsed.parameters ?? {};
  const args = typeof raw === "string" ? parsedObject(raw) : object(raw);
  return args ? toCall(parsed.name, args) : undefined;
}

function functionCall(body: string, offered: ReadonlyMap<string, OfferedTool>): ChatToolCall | undefined {
  const block = FUNCTION_BLOCK.exec(body);
  const tool = block ? offered.get(block[1]!) : undefined;
  if (!block || !tool) return undefined;
  const args: Record<string, unknown> = {};
  for (const [, key, raw] of block[2]!.matchAll(PARAMETER)) args[key!] = parameterValue(tool, key!, raw!);
  return toCall(block[1]!, args);
}

/** Each call's body in order, or undefined if anything but calls follows the first one. */
function taggedBodies(text: string): string[] | undefined {
  const bodies: string[] = [];
  let rest = text;
  while (rest.trim()) {
    rest = rest.trimStart();
    if (rest.startsWith(OPEN_FUNCTION)) {
      const end = rest.indexOf("</function>");
      if (end === -1) { bodies.push(rest); return bodies; }
      bodies.push(rest.slice(0, end + "</function>".length));
      rest = rest.slice(end + "</function>".length);
      continue;
    }
    if (!rest.startsWith(OPEN_TAG)) return undefined;
    rest = rest.slice(OPEN_TAG.length);
    const end = rest.indexOf(CLOSE_TAG);
    // A server that stops on the closing tag never sends it.
    if (end === -1) { bodies.push(rest); return bodies; }
    bodies.push(rest.slice(0, end));
    rest = rest.slice(end + CLOSE_TAG.length);
  }
  return bodies;
}

const firstCallAt = (text: string) => {
  const found = [text.indexOf(OPEN_TAG), text.indexOf(OPEN_FUNCTION)].filter((at) => at !== -1);
  return found.length ? Math.min(...found) : -1;
};

const withoutThinking = (text: string) => {
  const end = text.lastIndexOf(THINK_END);
  return end === -1 ? text : text.slice(end + THINK_END.length);
};

/** Null when the reply is a reply. */
export function textToolCalls(reply: string, tools: readonly OfferedTool[]): TextToolCalls | null {
  const offered = new Map(tools.map((tool) => [tool.function.name, tool]));
  const text = withoutThinking(reply).trim();
  const at = firstCallAt(text);
  if (at === -1) {
    const fenced = FENCED_JSON.exec(text)?.[1];
    const call = text.startsWith("{") || fenced ? jsonCall(fenced ?? text, offered) : undefined;
    return call ? { kind: "calls", calls: [call], text: "" } : null;
  }
  const said = text.slice(0, at).trimEnd();
  const bodies = taggedBodies(text.slice(at));
  // Calls followed by more words: an example or a quotation, not a request to run something.
  if (!bodies?.length || bodies.length > MAX_CALLS) return null;
  const calls: ChatToolCall[] = [];
  for (const body of bodies) {
    const call = body.includes(OPEN_FUNCTION) ? functionCall(body, offered) : jsonCall(body.trim(), offered);
    if (!call) return { kind: "unreadable", text: said };
    calls.push(call);
  }
  return { kind: "calls", calls, text: said };
}

const MARKERS = [OPEN_TAG, OPEN_FUNCTION];

function partialMarkerLength(text: string): number {
  for (let length = Math.min(text.length, Math.max(...MARKERS.map((marker) => marker.length - 1))); length > 0; length--) {
    const tail = text.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(tail))) return length;
  }
  return 0;
}

/** Keeps a call out of the streamed reply: words before it show as they arrive, and from where a call might start the
 * text waits until the reply ends and `textToolCalls` has decided. */
export class TextCallHoldback {
  private seen = "";
  private shown = 0;

  feed(delta: string): string {
    this.seen += delta;
    const start = this.seen.trimStart();
    // A reply opening like this may be one bare JSON call, which is only known at the end.
    if (!start || start.startsWith("{") || "```".startsWith(start.slice(0, 3)) || start.startsWith("```")) return "";
    const at = firstCallAt(this.seen);
    const end = at !== -1 ? at : this.seen.length - partialMarkerLength(this.seen);
    if (end <= this.shown) return "";
    const visible = this.seen.slice(this.shown, end);
    this.shown = end;
    return visible;
  }

  /** What is still held, for a reply that turned out to have no call in it. */
  rest(): string {
    const held = this.seen.slice(this.shown);
    this.shown = this.seen.length;
    return held;
  }
}
