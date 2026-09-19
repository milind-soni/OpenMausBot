/** Attachment wire protocol — the composer's attachment shapes, the tagged
 * prompt blocks composeMessage writes for them, and the transcript-side
 * split that reads those tags back out of stored messages. Moved verbatim
 * from src/lib/composer-attachments.ts; the client file re-exports these
 * under the same names. */

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
  /** Browser-local pixels shown immediately while the durable upload is in
   * flight and briefly handed to the transcript after Send. Never persisted. */
  previewUrl?: string;
  uploading?: boolean;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment;

/** The prompt the bot receives: what was typed, then one block per
 * attachment. Tagged blocks rather than fences — pasted code and markdown
 * carry fences of their own, and nesting them loses the boundary. A file
 * carries its path for the agent and its original name for the transcript. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    if (a.kind === "paste") {
      parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
    } else if (a.kind === "image") {
      parts.push(`<attached-image path="${escapeAttribute(a.path)}" name="${escapeAttribute(a.name)}" />`);
    } else {
      parts.push(`<attached-file path="${escapeAttribute(a.path)}" name="${escapeAttribute(a.name)}" />`);
    }
  });
  return parts.filter(Boolean).join("\n\n");
}

/** File paths are untrusted prompt content. Keep them inside the quoted
 * attribute even when a filename contains XML characters or line breaks. */
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

/** Decode only entities emitted by escapeAttribute. A second encoded pass
 * stays encoded, rather than turning attacker-controlled text into markup. */
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

/** Keep transcript-provided names compact and visually honest. File chips
 * are deliberately not links, but control and bidi characters can still
 * make an untrusted name misleading. */
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
  | { kind: "untilToken"; closingToken: string };

/** Recognise CommonMark-style fenced code without pulling a Markdown parser
 * into the composer bundle. An unterminated fence deliberately protects the
 * rest of the message: examples must never turn into actionable attachments. */
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

/** Attachment-looking examples inside CommonMark HTML blocks stay literal.
 * Types 1-5 use their specified terminator; types 6-7 last through the next
 * blank line. The app's pasted-text wrapper is deliberately stronger than a
 * generic custom tag and lasts through its closing tag, including blanks. */
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

/** Split a stored user message into its display text and attachments for
 * transcript rendering. Markdown exports preserve whitespace; bubbles trim it. */
export function splitTranscriptAttachments(text: string, trimDisplay = true): TranscriptAttachments {
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
      if (!consumed) block = transcriptBlockStarting(line);
    }

    if (!consumed) display += text.slice(cursor, wholeLineEnd);
    cursor = wholeLineEnd;
  }

  return { display: trimDisplay ? display.trim() : display, images, files };
}

/** Kept for callers outside the desktop bundle that used the old helper. */
export function splitAttachedImages(text: string): { display: string; images: string[] } {
  const { display, images } = splitTranscriptAttachments(text);
  return { display, images: images.map((image) => image.path) };
}

/** The bare filename a saved attachment path ends in — what the serving
 * route expects. Works for POSIX and Windows separators. */
export function attachmentBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
