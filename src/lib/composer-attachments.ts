import { isCitationAttachment, serializeCitation, type CitationAttachment } from "./citations.ts";
export { dataContextFor, type DataContext, type DataViewContext } from "../../shared/data-context.ts";

export type PasteAttachment = {
  kind: "paste";
  id: string;
  text: string;
  size: number;
  lines: number;
};

export type FileAttachment = {
  kind: "file";
  id: string;
  path: string;
  name: string;
  size: number;
};

export type ImageAttachment = {
  kind: "image";
  id: string;
  path: string;
  name: string;
  size: number;
  mime: string;
  previewUrl?: string;
  uploading?: boolean;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment | CitationAttachment;

export function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  if (attachment.kind === "citation") return isCitationAttachment(value);
  if (typeof attachment.id !== "string" || !validSize(attachment.size)) return false;
  if (attachment.kind === "paste") {
    return (
      typeof attachment.text === "string" &&
      typeof attachment.lines === "number" &&
      Number.isInteger(attachment.lines) &&
      attachment.lines >= 1
    );
  }
  if (attachment.kind === "file") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string"
    );
  }
  if (attachment.kind === "image") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string" &&
      typeof attachment.mime === "string" &&
      attachment.mime.startsWith("image/")
    );
  }
  return false;
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || countLines(text) >= PASTE_LINES;
}

export function countLines(text: string): number {
  return text.split("\n").length;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;
}

/** Stable across the one retry, so a lost success response cannot create a second file. */
function newUploadId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function fileAttachment(name: string, path: string, size: number): FileAttachment {
  return { kind: "file", id: newId(), path, name, size };
}

/** Must match the server's IMAGE_MAX_BYTES. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

const DOCUMENT_MIMES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  pdf: "application/pdf",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const ACCEPTED_DOCUMENT_MIMES = new Set(Object.values(DOCUMENT_MIMES));

const AUDIO_MIMES_BY_EXTENSION: Readonly<Record<string, string>> = {
  opus: "audio/opus",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
};
const ACCEPTED_AUDIO_MIMES = new Set([
  ...Object.values(AUDIO_MIMES_BY_EXTENSION),
  "audio/x-m4a", "audio/x-wav", "audio/wave", "audio/x-flac",
]);

export function documentMime(file: Pick<File, "name" | "type">): string | null {
  const declared = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (ACCEPTED_DOCUMENT_MIMES.has(declared)) return declared;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return DOCUMENT_MIMES[extension] ?? null;
}

export function isImageFile(file: { type: string; size?: number }): boolean {
  return (
    file.type.startsWith("image/") &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type.split(";")[0]!.trim().toLowerCase())
  );
}

/** Items first: Chromium on macOS exposes screenshots via items while clipboardData.files may stay empty. */
export function clipboardImageFiles(
  clipboardData: {
    files?: Iterable<File> | null;
    items?: Iterable<{ kind: string; type: string; getAsFile(): File | null }> | null;
  } | null | undefined,
): File[] {
  if (!clipboardData) return [];
  if (clipboardData.items) {
    const fromItems: File[] = [];
    for (const item of clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file && isImageFile(file)) {
          fromItems.push(file);
        }
      }
    }
    if (fromItems.length > 0) return fromItems;
  }
  if (clipboardData.files) {
    return Array.from(clipboardData.files).filter(isImageFile);
  }
  return [];
}

export function clipboardHasImages(
  clipboardData: {
    files?: Iterable<{ type: string; size?: number }> | null;
    items?: Iterable<{ kind: string; type: string }> | null;
  } | null | undefined,
): boolean {
  if (!clipboardData) return false;
  if (clipboardData.items) {
    for (const item of clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        return true;
      }
    }
  }
  if (clipboardData.files) {
    for (const file of clipboardData.files) {
      if (isImageFile(file)) return true;
    }
  }
  return false;
}

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const UPLOAD_ATTEMPTS = 2;

function retryableUploadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function uploadWithRetry<T>(url: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const aborted = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
      if (aborted || attempt === UPLOAD_ATTEMPTS - 1) throw error;
      continue;
    }
    if (!response.ok) {
      if (retryableUploadStatus(response.status) && attempt < UPLOAD_ATTEMPTS - 1) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const detail = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw Object.assign(new Error(detail.error ?? "upload failed"), { status: response.status });
    }
    try {
      return await response.json() as T;
    } catch (error) {
      if (attempt === UPLOAD_ATTEMPTS - 1) {
        throw new Error("upload returned an invalid response", { cause: error });
      }
    }
  }
  throw new Error("upload failed");
}

function canonicalImageName(originalName: string, path: string, mime: string): string {
  const normalizedMime = mime.split(";", 1)[0]!.trim().toLowerCase();
  const extension = IMAGE_EXTENSION_BY_MIME[normalizedMime];
  const pathName = attachmentBasename(path);
  if (!extension || !pathName.toLowerCase().endsWith(extension)) {
    throw new Error("upload returned invalid image metadata");
  }
  const original = attachmentBasename(originalName.trim());
  const dot = original.lastIndexOf(".");
  const stem = (dot > 0 ? original.slice(0, dot) : original).trim() || "pasted image";
  return `${stem}${extension}`;
}

export function optimisticImageAttachment(file: File): ImageAttachment | null {
  if (!isImageFile(file)) return null;
  if (file.size > IMAGE_MAX_BYTES) throw Object.assign(new Error(`${file.name} exceeds 10 MB`), { status: 413 });
  const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();
  const previewUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
  return {
    kind: "image",
    id: newId(),
    path: "",
    name: file.name || "image",
    size: file.size,
    mime,
    ...(previewUrl ? { previewUrl } : {}),
    uploading: true,
  };
}

export async function imageAttachmentFromFile(
  file: File,
  optimistic?: Pick<ImageAttachment, "id" | "previewUrl">,
): Promise<ImageAttachment | null> {
  if (!isImageFile(file)) return null;
  if (file.size > IMAGE_MAX_BYTES) throw Object.assign(new Error(`${file.name} exceeds 10 MB`), { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const uploadId = newUploadId();
  const saved = await uploadWithRetry<{ path: string; mime: string; bytes: number }>(
    `/api/attachments?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "POST",
      headers: { "content-type": file.type },
      body: bytes,
    },
  );
  return {
    kind: "image",
    id: optimistic?.id ?? newId(),
    path: saved.path,
    name: canonicalImageName(file.name, saved.path, saved.mime),
    size: saved.bytes,
    mime: saved.mime,
    ...(optimistic?.previewUrl ? { previewUrl: optimistic.previewUrl } : {}),
  };
}

/** Copied into the private store so the companion route never sees an arbitrary Finder path. */
export async function fileAttachmentFromFile(file: File): Promise<FileAttachment | null> {
  const declared = file.type.split(";", 1)[0]!.trim().toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = documentMime(file) ??
    (ACCEPTED_AUDIO_MIMES.has(declared) ? declared : AUDIO_MIMES_BY_EXTENSION[extension]);
  if (!mime) return null;
  if (file.size > FILE_MAX_BYTES) {
    throw Object.assign(new Error(`${file.name} exceeds 25 MB`), { status: 413 });
  }
  const uploadId = newUploadId();
  const saved = await uploadWithRetry<{ path: string; name: string; bytes: number }>(
    `/api/files?name=${encodeURIComponent(file.name)}&uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "POST",
      headers: { "content-type": mime },
      body: file,
    },
  );
  return fileAttachment(saved.name || file.name, saved.path, saved.bytes);
}

export function pasteAttachment(text: string): PasteAttachment {
  const id = newId();
  return { kind: "paste", id, text, size: byteLength(text), lines: countLines(text) };
}

export function appendPastedText(text: string, pasted: string): string {
  if (!text) return pasted;
  return `${text}${text.endsWith("\n") ? "" : "\n\n"}${pasted}`;
}

export const INLINE_DROP_LIMIT = 512 * 1024;

export type DroppedFile = Pick<File, "name" | "size" | "type" | "text"> &
  Partial<Pick<File, "arrayBuffer">>;

export async function attachmentsFromDroppedFiles<T extends DroppedFile>(
  files: readonly T[],
  getPath: (file: T) => string,
): Promise<{ attachments: Attachment[]; rejectedNames: string[] }> {
  const results = await Promise.all(
    files.map(async (file) => {
      let path = "";
      try {
        path = getPath(file);
      } catch {
      }
      if (path) return { attachment: fileAttachment(file.name, path, file.size) };
      if (isInlineText(file) && file.size <= INLINE_DROP_LIMIT) {
        try {
          return { attachment: pasteAttachment(await file.text()) };
        } catch {
        }
      }
      return { rejectedName: file.name };
    }),
  );

  return {
    attachments: results.flatMap((result) =>
      "attachment" in result && result.attachment ? [result.attachment] : [],
    ),
    rejectedNames: results.flatMap((result) =>
      "rejectedName" in result && result.rejectedName ? [result.rejectedName] : [],
    ),
  };
}

function isInlineText(file: DroppedFile): boolean {
  return file.type.startsWith("text/") || file.type === "application/json";
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function pasteSummary(a: { lines: number; size: number }): string {
  return `${a.lines} lines, ${formatSize(a.size)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    if (a.kind === "citation") {
      parts.push(serializeCitation(a));
    } else if (a.kind === "paste") {
      parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
    } else if (a.kind === "image") {
      parts.push(`<attached-image path="${escapeAttribute(a.path)}" name="${escapeAttribute(a.name)}" />`);
    } else {
      parts.push(`<attached-file path="${escapeAttribute(a.path)}" name="${escapeAttribute(a.name)}" />`);
    }
  });
  return parts.filter(Boolean).join("\n\n");
}

/** File paths are untrusted prompt content: keep them inside the quoted attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

export type TranscriptFileAttachment = {
  path: string;
  name: string;
  private?: boolean;
};

export type TranscriptImageAttachment = {
  path: string;
  name: string;
  private?: boolean;
};

export type TranscriptAttachments = {
  display: string;
  images: TranscriptImageAttachment[];
  files: TranscriptFileAttachment[];
};

/** A second encoded pass stays encoded rather than turning attacker-controlled text into markup. */
function decodeAttachmentAttribute(value: string): string {
  return value.replace(/&(quot|lt|gt|amp);|&#(9|10|13);/g, (entity, named: string | undefined, numeric: string | undefined) => {
    if (numeric === "9") return "\t";
    if (numeric === "10") return "\n";
    if (numeric === "13") return "\r";
    if (named === "quot") return '"';
    if (named === "lt") return "<";
    if (named === "gt") return ">";
    if (named === "amp") return "&";
    return entity;
  });
}

/** Control and bidi characters can make an untrusted name misleading. */
function transcriptFileName(path: string, suppliedName?: string): string {
  const decoded = suppliedName ? decodeAttachmentAttribute(suppliedName) : attachmentBasename(path);
  const clean = (value: string) => Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const control = code <= 31 || (code >= 127 && code <= 159);
    const bidiControl = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return control || bidiControl ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  const safe = clean(attachmentBasename(decoded));
  const fallback = clean(attachmentBasename(path));
  return Array.from(safe || fallback || "Attached file").slice(0, 180).join("");
}

export function isPrivateAttachmentPath(path: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i
    .test(attachmentBasename(path));
}

type TranscriptFence = {
  marker: "`" | "~";
  length: number;
};

type TranscriptBlock =
  | { kind: "untilBlank" }
  | { kind: "untilToken"; closingToken: string; hiddenWrapper?: boolean };

const PASTED_TEXT_OPEN = /^ {0,3}<pasted-text(?:[\t ]+index="\d+")?[\t ]*>[\t ]*$/i;
const PASTED_TEXT_CLOSE = /^[\t ]*<\/pasted-text>[\t ]*$/i;

/** An unterminated fence protects the rest of the message: examples must never become actionable attachments. */
function transcriptFenceMarker(line: string): (TranscriptFence & { remainder: string }) | null {
  let index = 0;
  while (index < line.length && index < 4 && line[index] === " ") index += 1;
  if (index > 3) return null;
  const marker = line[index];
  if (marker !== "`" && marker !== "~") return null;
  const start = index;
  while (index < line.length && line[index] === marker) index += 1;
  const length = index - start;
  if (length < 3) return null;
  return { marker, length, remainder: line.slice(index) };
}

const COMMONMARK_BLOCK_TAGS = [
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
  "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "frame", "frameset", "h[1-6]", "head", "header", "hr", "html", "iframe", "legend",
  "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
  "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title",
  "tr", "track", "ul",
].join("|");

const COMMONMARK_TYPE_1 = /^ {0,3}<(script|pre|style|textarea)(?:[\t ]|>|$)/i;
const COMMONMARK_TYPE_6 = new RegExp(
  `^ {0,3}</?(?:${COMMONMARK_BLOCK_TAGS})(?:[\\t ]|/?>|$)`,
  "i",
);
const HTML_ATTRIBUTE_NAME = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const HTML_ATTRIBUTE_VALUE = `(?:[^\\s"'=<>\\x60]+|'[^']*'|"[^"]*")`;
const HTML_ATTRIBUTE = `(?:[\\t ]+${HTML_ATTRIBUTE_NAME}(?:[\\t ]*=[\\t ]*${HTML_ATTRIBUTE_VALUE})?)`;
const COMMONMARK_TYPE_7 = new RegExp(
  `^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*${HTML_ATTRIBUTE}*[\\t ]*/?>|</[A-Za-z][A-Za-z0-9-]*[\\t ]*>)[\\t ]*$`,
);

/** CommonMark HTML blocks: types 1-5 end at their terminator, types 6-7 at the next blank line. */
function transcriptBlockStarting(line: string): TranscriptBlock | null {
  const lower = line.toLowerCase();
  const commentStart = lower.indexOf("<!--");
  if (commentStart >= 0 && lower.indexOf("-->", commentStart + 4) < 0) {
    return { kind: "untilToken", closingToken: "-->" };
  }

  const content = line.match(/^ {0,3}(.*)$/)?.[1];
  if (content === undefined) return null;
  const lowerContent = content.toLowerCase();

  const pastedText = /^<pasted-text(?:[\t >]|$)/i.exec(content);
  if (pastedText) {
    return lowerContent.includes("</pasted-text>")
      ? null
      : { kind: "untilToken", closingToken: "</pasted-text>" };
  }

  const typeOne = COMMONMARK_TYPE_1.exec(line);
  if (typeOne) {
    const closingToken = `</${typeOne[1]!.toLowerCase()}>`;
    return lower.includes(closingToken)
      ? null
      : { kind: "untilToken", closingToken };
  }

  const processing = lowerContent.indexOf("<?");
  if (processing === 0) {
    return lowerContent.indexOf("?>", 2) >= 0
      ? null
      : { kind: "untilToken", closingToken: "?>" };
  }
  const cdata = lowerContent.indexOf("<![cdata[");
  if (cdata === 0) {
    return lowerContent.indexOf("]]>", 9) >= 0
      ? null
      : { kind: "untilToken", closingToken: "]]>" };
  }
  if (/^<![A-Za-z]/.test(content)) {
    return content.indexOf(">", 2) >= 0
      ? null
      : { kind: "untilToken", closingToken: ">" };
  }

  if (COMMONMARK_TYPE_6.test(line) || COMMONMARK_TYPE_7.test(line)) {
    return { kind: "untilBlank" };
  }
  return null;
}

const TRANSCRIPT_ATTACHMENT_TAG =
  /^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>[\t ]*$/;

export function splitTranscriptAttachments(
  text: string,
  trimDisplay = true,
  hidePasteWrappers = true,
): TranscriptAttachments {
  const images: TranscriptImageAttachment[] = [];
  const files: TranscriptFileAttachment[] = [];
  let display = "";
  let fence: TranscriptFence | null = null;
  let block: TranscriptBlock | null = null;
  let cursor = 0;

  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline >= 0 ? newline : text.length;
    const wholeLineEnd = newline >= 0 ? newline + 1 : text.length;
    const rawLine = text.slice(cursor, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const marker = transcriptFenceMarker(line);
    let consumed = false;

    if (fence) {
      if (
        marker &&
        marker.marker === fence.marker &&
        marker.length >= fence.length &&
        /^[\t ]*$/.test(marker.remainder)
      ) {
        fence = null;
      }
    } else if (block) {
      if (block.kind === "untilBlank") {
        if (/^[\t ]*$/.test(line)) block = null;
      } else if (line.toLowerCase().includes(block.closingToken)) {
        if (block.hiddenWrapper && PASTED_TEXT_CLOSE.test(line)) consumed = true;
        block = null;
      }
    } else if (marker) {
      fence = { marker: marker.marker, length: marker.length };
    } else {
      const match = TRANSCRIPT_ATTACHMENT_TAG.exec(line);
      if (match) {
        const kind = match[1] as "image" | "file";
        const path = decodeAttachmentAttribute(match[2]!);
        if (path) {
          const attachment = {
            path,
            name: transcriptFileName(path, match[3]),
            ...(isPrivateAttachmentPath(path) ? { private: true } : {}),
          };
          if (kind === "image") images.push(attachment);
          else files.push(attachment);
          consumed = true;
        }
      }
      if (!consumed) {
        block = transcriptBlockStarting(line);
        if (hidePasteWrappers && block?.kind === "untilToken" && block.closingToken === "</pasted-text>" && PASTED_TEXT_OPEN.test(line)) {
          block = { ...block, hiddenWrapper: true };
          consumed = true;
        }
      }
    }

    if (!consumed) display += text.slice(cursor, wholeLineEnd);
    cursor = wholeLineEnd;
  }

  return { display: trimDisplay ? display.trim() : display, images, files };
}

export function splitAttachedImages(text: string): { display: string; images: string[] } {
  const { display, images } = splitTranscriptAttachments(text);
  return { display, images: images.map((image) => image.path) };
}

/** A file uploaded for a message and taken off it before sending: the server keeps it only while a message uses it. */
export function discardUnsentUpload(attachment: Attachment): void {
  if ((attachment.kind !== "image" && attachment.kind !== "file") || !attachment.path) return;
  const name = attachmentBasename(attachment.path);
  if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,10}$/.test(name)) return;
  void fetch(`/api/attachments/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => undefined);
}

export function attachmentBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

const previewHandoffs = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>();
const PREVIEW_HANDOFF_MS = 60_000;

function revokeBlobUrl(url: string | undefined): void {
  if (!url?.startsWith("blob:") || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

export function handoffAttachmentImagePreview(path: string, previewUrl: string | undefined): void {
  if (!path || !previewUrl?.startsWith("blob:")) return;
  const previous = previewHandoffs.get(path);
  if (previous) {
    clearTimeout(previous.timer);
    if (previous.url !== previewUrl) revokeBlobUrl(previous.url);
  }
  const timer = setTimeout(() => {
    if (previewHandoffs.get(path)?.url !== previewUrl) return;
    previewHandoffs.delete(path);
    revokeBlobUrl(previewUrl);
  }, PREVIEW_HANDOFF_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  previewHandoffs.set(path, { url: previewUrl, timer });
}

export function releaseAttachmentImagePreview(attachment: ImageAttachment): void {
  const handed = attachment.path ? previewHandoffs.get(attachment.path) : undefined;
  if (handed && handed.url === attachment.previewUrl) {
    clearTimeout(handed.timer);
    previewHandoffs.delete(attachment.path);
  }
  revokeBlobUrl(attachment.previewUrl);
}

/** The renderer never loads a transcript-provided URL directly; only server-generated names become same-origin URLs. */
export function attachmentImageUrl(path: string): string | null {
  const local = previewHandoffs.get(path);
  if (local) return local.url;
  const name = attachmentBasename(path);
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return null;
  return `/api/attachments/${encodeURIComponent(name)}`;
}

export function attachmentAudioUrl(path: string): string | null {
  const name = attachmentBasename(path);
  if (!/^[A-Za-z0-9-]+\.(?:mp3|wav)$/.test(name)) return null;
  return `/api/attachments/${encodeURIComponent(name)}`;
}

export async function intakeFiles<T extends DroppedFile & { type: string }>(
  _files: readonly T[],
  _opts: {
    allowImages: boolean;
    getPath: (file: T) => string;
    uploadImage: (file: T) => Promise<Attachment | null>;
    uploadFile?: (file: T) => Promise<FileAttachment | null>;
  },
): Promise<{ attachments: Attachment[]; notice: string | null }> {
  const files = [..._files];
  const { allowImages, getPath, uploadImage } = _opts;
  const uploadFile = _opts.uploadFile ?? (async (file: T) => {
    if (!file.arrayBuffer) return null;
    return fileAttachmentFromFile(file as unknown as File);
  });
  const results = await Promise.all(files.map(async (file): Promise<{
    attachments: Attachment[];
    rejectedNames: string[];
    uploadError?: string;
  }> => {
    if (allowImages && isImageFile(file)) {
      try {
        const attachment = await uploadImage(file);
        return { attachments: attachment ? [attachment] : [], rejectedNames: [] };
      } catch (err) {
        return {
          attachments: [],
          rejectedNames: [],
          uploadError: `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`,
        };
      }
    }
    try {
      const attachment = await uploadFile(file);
      if (attachment) {
        return { attachments: [attachment], rejectedNames: [] };
      }
    } catch (err) {
      return {
        attachments: [],
        rejectedNames: [],
        uploadError: `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`,
      };
    }
    const result = await attachmentsFromDroppedFiles([file], getPath);
    return result;
  }));
  const attachments = results.flatMap((result) => result.attachments);
  const rejectedNames = results.flatMap((result) => result.rejectedNames);
  const uploadErrors = results.flatMap((result) => result.uploadError ? [result.uploadError] : []);
  const pathless = rejectedNames.length
    ? `Unable to attach ${rejectedNames.join(", ")}. Choose a supported image, document, or audio file.`
    : null;
  const failed = uploadErrors.length ? uploadErrors.join("; ") : null;
  return {
    attachments,
    notice: pathless && failed ? `${pathless} (${failed})` : (pathless ?? failed),
  };
}

export function composerShouldRefocus(active: FocusNode | null, input: ComposerInputNode): boolean {
  if (!active || active === input) return true;
  const root = input.ownerDocument;
  if (active === root.body || active === root.documentElement) return true;
  const composer = input.closest("[data-tour=composer]");
  return Boolean(composer?.contains(active));
}

export function composerTakesFocusOnOpen(active: OpenFocusNode | null, input: ComposerInputNode): boolean {
  if (composerShouldRefocus(active, input)) return true;
  if (!active) return true;
  const tag = active.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) return false;
  return !active.closest?.("[role=dialog], [role=alertdialog], [aria-modal=true]");
}

export function replyTargetTakesFocus(previousId: string | null | undefined, nextId: string | null | undefined): boolean {
  return Boolean(nextId) && nextId !== previousId;
}

// Also compiled for the server, which has no DOM types.
type FocusNode = object;
interface OpenFocusNode {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): object | null;
}
interface ComposerInputNode {
  ownerDocument: { body: FocusNode | null; documentElement: FocusNode | null };
  closest(selector: string): { contains(node: FocusNode | null): boolean } | null;
}
