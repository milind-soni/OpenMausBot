import { readFileSync, statSync } from "node:fs";
import type { SendTurnInput, TurnVideoInput } from "../contracts.ts";

export interface ChatImagePart { type: "image_url"; image_url: { url: string } }
export interface ChatTextPart { type: "text"; text: string }
export type ChatContentPart = ChatTextPart | ChatImagePart;
const IMAGE_BYTES = 20 * 1024 * 1024;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const CHAT_IMAGE_BUDGET = 32 * 1024 * 1024;
// Gemini, the one engine sent clips, names QuickTime video/mov.
const VIDEO_MIME: Readonly<Record<TurnVideoInput["mime"], string>> = { "video/mp4": "video/mp4", "video/webm": "video/webm", "video/quicktime": "video/mov" };
const urlPrefix = (mime: string) => `data:${VIDEO_MIME[mime as TurnVideoInput["mime"]] ?? mime};base64,`;

/** Length of the data URL a turn's image or clip of `bytes` becomes, which is what `chatImageBudget` counts. */
export const chatMediaUrlBytes = (media: { mime: string; bytes: number }) => urlPrefix(media.mime).length + Math.ceil(media.bytes / 3) * 4;

/** Bound retained base64 before JSON serialization or another model call. */
export function chatImageBudget() {
  let used = 0;
  return (parts: string | ChatContentPart[] | null) => {
    if (!Array.isArray(parts)) return;
    const added = parts.reduce((total, part) => total + (part.type === "image_url" ? part.image_url.url.length : 0), 0);
    if (used + added > CHAT_IMAGE_BUDGET) throw new Error("Turn image budget exceeded (32 MiB encoded); screenshot cannot be retained. An operation may already have taken effect; inspect its state before retrying.");
    used += added;
  };
}

export function assertImageTransport(url: string) {
  const endpoint = new URL(url);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("Images and computer tools require HTTPS for remote API endpoints; HTTP is supported only on loopback.");
  }
}

export function chatImage(item: { mimeType?: unknown; data?: unknown }): ChatImagePart {
  const { mimeType, data } = item;
  if (typeof mimeType !== "string" || !MIME.has(mimeType) || typeof data !== "string" ||
      !data.length || data.length > Math.ceil(IMAGE_BYTES / 3) * 4 || data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Invalid or oversized MCP image");
  }
  const bytes = Buffer.from(data, "base64");
  const matches = mimeType === "image/png" ? bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR"
    : mimeType === "image/jpeg" ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === "image/gif" ? bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    : bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (bytes.length > IMAGE_BYTES || bytes.toString("base64") !== data || !matches) throw new Error("Image bytes do not match the declared MIME type");
  return { type: "image_url", image_url: { url: urlPrefix(mimeType) + data } };
}

/** Stands in for a clip removed from disk after it was attached, so the rest of the turn still goes. */
export const UNREADABLE_CLIP_NOTE = "[An attached video could no longer be read and was left out. Tell the person to attach it again.]";

export function chatUserContent(turn: SendTurnInput): string | ChatContentPart[] {
  if (!turn.images?.length && !turn.videos?.length) return turn.text;
  const budget = chatImageBudget();
  const parts: ChatContentPart[] = (turn.images ?? []).map(image => {
    if (statSync(image.path).size > IMAGE_BYTES) throw new Error("Image exceeds 20 MB");
    const part = chatImage({ mimeType: image.mime, data: readFileSync(image.path).toString("base64") });
    budget([part]);
    return part;
  });
  for (const video of turn.videos ?? []) {
    let data: string;
    try { data = readFileSync(video.path).toString("base64"); } catch {
      parts.push({ type: "text", text: UNREADABLE_CLIP_NOTE });
      continue;
    }
    const part: ChatImagePart = { type: "image_url", image_url: { url: urlPrefix(video.mime) + data } };
    budget([part]);
    parts.push(part);
  }
  return [{ type: "text", text: turn.text }, ...parts];
}

export function chatToolImages(callId: string, images?: ChatImagePart[]): ChatContentPart[] {
  return images?.length ? [{ type: "text", text: `Screenshot result from tool call ${callId}:` }, ...images] : [];
}
