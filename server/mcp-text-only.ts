// A model that reads text only: Z.ai GLM's OpenAI-compatible endpoints (api.z.ai and open.bigmodel.cn) refuse a
// request whose message content holds an image part — "messages.content.type is invalid, allowed values: ['text']"
// — and an engine resends its whole session every turn, so one image anywhere in the conversation fails every
// later message. A refusal teaches the model's key here; after that, the turn's MCP servers answer tool calls
// with the image parts replaced by a text note the model can read.

/** Rides the prompt of a turn on a model that reads text only: the engine's own file tools can still read an image into
 * the session (an MCP server is stripped, a plain read is not), and the next refusal marks that session for a rebuild
 * from the recovery text. */
export const TEXT_ONLY_PROMPT_NOTE = "(Your model for this conversation reads text only. Reading an image file with a file tool, or keeping a picture a tool returned, makes every later reply fail. Say you cannot see it, or attach the file unchanged.)";

/** Set in the environment of every MCP server a turn mounts for a model that reads text only. */
export const TEXT_ONLY_TOOLS_ENV = "OMB_MCP_TEXT_ONLY";

export function textOnlyToolsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEXT_ONLY_TOOLS_ENV] === "1";
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** One image content part as the note that replaces it: what it was, so the model can say so. */
function imageNote(part: Record<string, unknown>): string {
  const mime = typeof part.mimeType === "string" ? part.mimeType : "image";
  const bytes = typeof part.data === "string" ? Math.max(1, Math.round(part.data.length * 3 / 4 / 1024)) : 0;
  return `[Image from this tool's result not shown: this model reads text only (${mime}${bytes ? `, ~${bytes} kB` : ""}).]`;
}

/** A tools/call result with every image content part replaced by a text note, in place; true when one was. A result
 * that carries no image, or no readable content array, is left exactly as the server sent it. */
export function withoutResultImages(result: unknown): boolean {
  if (!isRecord(result) || !Array.isArray(result.content)) return false;
  let replaced = false;
  result.content = (result.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== "image") return part;
    replaced = true;
    return { type: "text", text: imageNote(part) };
  });
  return replaced;
}

const LEARNED_MAX = 500;
const learned = new Set<string>();

/** Remembers a model that reads text only until the server restarts; the oldest entry goes first past LEARNED_MAX. */
export function learnTextOnlyTools(key: string): void {
  learned.delete(key);
  learned.add(key);
  if (learned.size > LEARNED_MAX) {
    const oldest = learned.keys().next().value;
    if (oldest !== undefined) learned.delete(oldest);
  }
}

export function learnedTextOnlyTools(key: string): boolean {
  return learned.has(key);
}

export function forgetTextOnlyTools(): void {
  learned.clear();
}
