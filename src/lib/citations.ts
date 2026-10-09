// Selection matching is adapted from T3 Code's assistantTextSelection.ts
// (Copyright 2026 T3 Tools Inc., MIT License; see third_party/t3-code/LICENSE).
import { withoutDataContext } from "../../shared/data-context.ts";

export const CITATION_MAX_QUOTE_LENGTH = 12_000;
export const CITATION_MAX_COMMENT_LENGTH = 4_000;
const CITATION_CONTEXT_LENGTH = 64;
const CITATION_MARKER = "<!--omb-citation-v1:";
const CITATION_MARKER_RE = /<!--omb-citation-v1:([A-Za-z0-9_-]{1,100000})-->/g;

export type CitationSource = {
  ownerType: "bot" | "group";
  ownerId: string;
  threadId: string;
  messageId: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
};

export type CitationAttachment = {
  kind: "citation";
  version: 1;
  id: string;
  quote: string;
  comment?: string;
  source: CitationSource;
  size: number;
};

export type CitationTextSelector = Pick<CitationSource, "start" | "end" | "prefix" | "suffix"> & {
  text: string;
};

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

export function isCitationAttachment(value: unknown): value is CitationAttachment {
  if (!value || typeof value !== "object") return false;
  const citation = value as Record<string, unknown>;
  const source = citation.source as Record<string, unknown> | undefined;
  return citation.kind === "citation" &&
    citation.version === 1 &&
    boundedString(citation.id, 200) &&
    boundedString(citation.quote, CITATION_MAX_QUOTE_LENGTH) &&
    (citation.comment === undefined || boundedString(citation.comment, CITATION_MAX_COMMENT_LENGTH, true)) &&
    typeof citation.size === "number" && Number.isFinite(citation.size) && citation.size >= 0 &&
    Boolean(source) &&
    (source!.ownerType === "bot" || source!.ownerType === "group") &&
    boundedString(source!.ownerId, 200) &&
    boundedString(source!.threadId, 200) &&
    boundedString(source!.messageId, 200) &&
    Number.isSafeInteger(source!.start) && Number(source!.start) >= 0 &&
    Number.isSafeInteger(source!.end) && Number(source!.end) >= Number(source!.start) &&
    boundedString(source!.prefix, CITATION_CONTEXT_LENGTH, true) &&
    boundedString(source!.suffix, CITATION_CONTEXT_LENGTH, true);
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Math.random().toString(36).slice(2)}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function citationAttachment(
  source: Omit<CitationSource, "start" | "end" | "prefix" | "suffix">,
  selector: CitationTextSelector,
  comment = "",
): CitationAttachment {
  const trimmedComment = comment.trim();
  if (!selector.text.trim() || selector.text.length > CITATION_MAX_QUOTE_LENGTH) {
    throw new Error("Citation quote is empty or too long");
  }
  if (trimmedComment.length > CITATION_MAX_COMMENT_LENGTH) throw new Error("Citation comment is too long");
  return {
    kind: "citation",
    version: 1,
    id: newId(),
    quote: selector.text,
    ...(trimmedComment ? { comment: trimmedComment } : {}),
    source: { ...source, start: selector.start, end: selector.end, prefix: selector.prefix, suffix: selector.suffix },
    size: byteLength(selector.text) + byteLength(trimmedComment),
  };
}

export function withCitationComment(citation: CitationAttachment, comment: string): CitationAttachment {
  const trimmed = comment.trim();
  if (trimmed.length > CITATION_MAX_COMMENT_LENGTH) throw new Error("Citation comment is too long");
  const { comment: _old, ...rest } = citation;
  return { ...rest, ...(trimmed ? { comment: trimmed } : {}), size: byteLength(citation.quote) + byteLength(trimmed) };
}

function base64UrlEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): unknown {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
}

/** Readable in clients without citation UI and unambiguous to model providers. */
export function citationFallback(citation: CitationAttachment): string {
  const quote = citation.quote.split("\n").map((line) => `> ${line}`).join("\n");
  return `> Quoted message:\n${quote}${citation.comment ? `\n\nComment:\n${citation.comment}` : ""}`;
}

export function serializeCitation(citation: CitationAttachment): string {
  return `${CITATION_MARKER}${base64UrlEncode(citation)}-->\n${citationFallback(citation)}`;
}

export function splitTranscriptCitations(text: string): { display: string; citations: CitationAttachment[] } {
  const citations: CitationAttachment[] = [];
  let display = "";
  let cursor = 0;
  for (const match of text.matchAll(CITATION_MARKER_RE)) {
    if (match.index < cursor) continue;
    let citation: CitationAttachment;
    try {
      const decoded = base64UrlDecode(match[1]!);
      if (!isCitationAttachment(decoded)) continue;
      citation = decoded;
    } catch {
      continue;
    }
    const block = `${match[0]}\n${citationFallback(citation)}`;
    if (!text.startsWith(block, match.index)) continue;
    display += text.slice(cursor, match.index);
    cursor = match.index + block.length;
    citations.push(citation);
  }
  return { display: `${display}${text.slice(cursor)}`.trim(), citations };
}

export function citationPreviewText(text: string): string {
  text = withoutDataContext(text);
  const cited = splitTranscriptCitations(text);
  if (!cited.citations.length) return text;
  return [
    cited.display,
    ...cited.citations.map((citation) => citation.comment
      ? `${citation.quote} — ${citation.comment}`
      : citation.quote),
  ].filter(Boolean).join(" ");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function createCitationTextSelector(text: string, rawStart: number, rawEnd: number): CitationTextSelector | null {
  const quote = text.slice(rawStart, rawEnd);
  if (!quote.trim()) return null;
  const normalized = normalizeWhitespace(text);
  let start = normalizeWhitespace(text.slice(0, rawStart)).length;
  if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) start -= 1;
  const end = normalizeWhitespace(text.slice(0, rawEnd)).length;
  let prefixStart = Math.max(0, start - CITATION_CONTEXT_LENGTH);
  let suffixEnd = Math.min(normalized.length, end + CITATION_CONTEXT_LENGTH);
  if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
  return {
    text: quote,
    start,
    end,
    prefix: normalized.slice(prefixStart, start),
    suffix: normalized.slice(end, suffixEnd),
  };
}

export function findCitationText(text: string, selector: CitationTextSelector): { start: number; end: number } | null {
  const normalized = normalizeWhitespace(text);
  const quote = normalizeWhitespace(selector.text);
  if (!quote.trim()) return null;
  const prefix = normalizeWhitespace(selector.prefix);
  const suffix = normalizeWhitespace(selector.suffix);
  const matchesContext = (start: number, end: number) =>
    normalized.slice(Math.max(0, start - prefix.length), start) === prefix &&
    normalized.slice(end, end + suffix.length) === suffix;
  let match = Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end) &&
      selector.start >= 0 && selector.end - selector.start === quote.length &&
      normalized.slice(selector.start, selector.end) === quote && matchesContext(selector.start, selector.end)
    ? { start: selector.start, end: selector.end }
    : null;
  let onlyQuote: { start: number; end: number } | null = null;
  let quoteCount = 0;
  for (let start = normalized.indexOf(quote); start !== -1; start = normalized.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    quoteCount += 1;
    onlyQuote = { start, end };
    if (!matchesContext(start, end)) continue;
    if (match && match.start !== start) return null;
    match = { start, end };
  }
  return match ?? (quoteCount === 1 ? onlyQuote : null);
}
