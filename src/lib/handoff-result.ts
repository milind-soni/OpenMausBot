import type { Message } from "@/state/store";

const PREVIEW_MAX = 140;

export interface HandoffResult {
  preview: string;
  /** The reply beyond the preview, or null when the preview already shows all of it. */
  more: string | null;
}

export function handoffResult(message: Pick<Message, "roomRequest" | "tool">): HandoffResult | null {
  if (message.roomRequest?.phase !== "result") return null;
  const body = message.tool?.output?.trim();
  if (!body) return null;
  const [first = "", ...rest] = body.split("\n");
  const line = first.trim();
  if (line.length > PREVIEW_MAX) return { preview: `${line.slice(0, PREVIEW_MAX - 1).trimEnd()}…`, more: body };
  const remainder = rest.join("\n").trim();
  return { preview: line, more: remainder || null };
}
