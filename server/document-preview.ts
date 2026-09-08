// Preview bytes come from the SAME authorised handle as a file download.
// No path lookup, embedded resources, or office/HTML execution lives here.
import { extname } from "node:path";
import type { OpenedMessageFile } from "./message-file.ts";

export const DOCUMENT_PREVIEW_MAX_BYTES = 256 * 1024;
export interface DocumentPreview {
  name: string;
  bytes: number;
  kind: "markdown" | "text" | "download";
  text?: string;
  truncated: boolean;
}

const TEXT_EXTENSIONS = new Set([".txt", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml"]);

/** Read bounded UTF-8 content from an already authorized handle; the caller
 * retains ownership of closing it. Unsupported content remains download-only. */
export async function readDocumentPreview(file: OpenedMessageFile): Promise<DocumentPreview> {
  const extension = extname(file.name).toLowerCase();
  const kind = extension === ".md" || extension === ".markdown" ? "markdown"
    : TEXT_EXTENSIONS.has(extension) ? "text" : "download";
  const base: DocumentPreview = { name: file.name, bytes: file.bytes, kind, truncated: false };
  if (kind === "download") return base;
  const buffer = Buffer.alloc(Math.min(file.bytes, DOCUMENT_PREVIEW_MAX_BYTES));
  let read = 0;
  while (read < buffer.length) {
    const result = await file.handle.read(buffer, read, buffer.length - read, read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  const truncated = file.bytes > read;
  try {
    // stream:true tolerates ONLY an incomplete final UTF-8 character at the
    // preview boundary. Invalid encodings/binary payloads stay download-only.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read), { stream: truncated });
    if (text.includes("\0")) return { ...base, kind: "download" };
    return { ...base, text, truncated };
  } catch {
    return { ...base, kind: "download" };
  }
}
