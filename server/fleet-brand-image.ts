// Turns an image a reseller supplies into a data URI the workspace may show. Pure: it reads nothing and fetches nothing.
import { MAX_FAVICON_CHARS, MAX_LOGO_CHARS } from "./brand-schema.ts";

export type ImageKind = "logo" | "favicon";
export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "svg" | "ico";

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const FORMATS_BY_MIME = new Map<string, ImageFormat>([...Object.entries(MIME).map(([format, mime]) => [mime, format as ImageFormat] as const), ["image/vnd.microsoft.icon", "ico"]]);

const MAX_CHARS: Record<ImageKind, number> = { logo: MAX_LOGO_CHARS, favicon: MAX_FAVICON_CHARS };

const startsWith = (bytes: Uint8Array, head: number[], at = 0) => head.every((byte, index) => bytes[at + index] === byte);
const SVG_ROOT = /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return SVG_ROOT.test(text.replace(/^﻿/, "").trimStart());
}

/** The format the bytes are, by their content; a file name or declared type proves nothing. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && (bytes[4] ?? 0) > 0) return "ico";
  return isSvg(bytes) ? "svg" : null;
}

/** The most raw bytes whose base64 data URI of this type stays within the brand schema's limit for the field. */
export function maxRawBytes(kind: ImageKind, format: ImageFormat): number {
  return Math.floor((MAX_CHARS[kind] - `data:${MIME[format]};base64,`.length) / 4) * 3;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const codePoint = (value: number) => String.fromCodePoint(Math.min(value, 0x10ffff));

const decodeCharacterReferences = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, digits: string) => codePoint(Number(digits)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);

const decodeCssEscapes = (text: string) => text.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?/gi, (_, hex: string) => codePoint(parseInt(hex, 16))).replace(/\\([\s\S])/g, "$1");

const compact = (text: string) => [...text].filter((char) => char.trim() && char.charCodeAt(0) > 31).join("").toLowerCase();

const EMBEDDED = "an embedded document";
const OUTSIDE = "an outside reference (only #id links inside the image are allowed)";
const CSS_URL = "a CSS url() outside the image";
const REFUSED_ELEMENTS: Record<string, string> = { script: "<script", handler: "<script", foreignobject: "<foreignObject", iframe: EMBEDDED, embed: EMBEDDED, object: EMBEDDED };
const ELEMENT = /<\s*(?:\/\s*)?(?:[^\s<>/"'=:]{1,80}\s*:\s*)?([^\s<>/"'=:]{1,80})/g;
const FRAGMENT = /^#[\p{L}\p{N}_.-]+$/u;

function valueAt(text: string, at: number, unquoted: RegExp): string {
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, at + 1);
    return text.slice(at + 1, end === -1 ? undefined : end);
  }
  unquoted.lastIndex = at;
  return unquoted.exec(text)?.[0] ?? "";
}

const ATTRIBUTE_VALUE = /[^\s>"'=]*/y;
const CSS_URL_VALUE = /[^\s)"']*/y;

/** Every check runs on every position, so text that misleads one reading of the quotes can only cause a refusal. */
function svgRefusal(source: string): string | undefined {
  const text = decodeCharacterReferences(source);
  for (const [, name] of text.matchAll(ELEMENT)) {
    const refused = REFUSED_ELEMENTS[name!.toLowerCase()];
    if (refused) return refused;
  }
  if (/<!\s*ENTITY/i.test(text)) return "an entity declaration";
  if (/<!\s*DOCTYPE/i.test(text)) return "a DOCTYPE";
  if (/[\s"'/:]on[a-z]+\s*=/i.test(text)) return "an on...= event attribute";
  if (compact(text).includes("javascript:")) return "a javascript: link";
  for (const match of text.matchAll(/(?<![\w.-])href\s*=\s*/gi)) {
    if (!FRAGMENT.test(valueAt(text, match.index + match[0].length, ATTRIBUTE_VALUE).trim())) return OUTSIDE;
  }
  if (/(?<![\w.-])xml\s*:\s*base\s*=/i.test(text) || /attributeName\s*=\s*(?:["']\s*)?(?:[\w.-]+\s*:\s*)?href(?![\w.-])/i.test(text)) return OUTSIDE;
  for (const match of text.matchAll(/=\s*/g)) {
    if (compact(valueAt(text, match.index + match[0].length, ATTRIBUTE_VALUE)).includes("data:")) return "a data: address";
  }
  const css = decodeCssEscapes(text);
  if (/@import/i.test(css)) return "a CSS @import";
  if (/image-set\s*\(/i.test(css)) return CSS_URL;
  for (const match of css.matchAll(/url\s*\(\s*/gi)) {
    if (!FRAGMENT.test(valueAt(css, match.index + match[0].length, CSS_URL_VALUE).trim())) return CSS_URL;
  }
  return undefined;
}

function assertSafeSvg(bytes: Uint8Array, label: string): void {
  const refused = svgRefusal(new TextDecoder("utf-8").decode(bytes));
  if (refused) throw new Error(`${label} is an SVG that contains ${refused}; export a plain SVG without scripts, events, embedded documents or outside references`);
}

const kilobytes = (bytes: number, round: (value: number) => number) => `${round(bytes / 1024)} KB`;

/** Throws a plain message for anything that is not a small, harmless image of an allowed type. */
export function inspectImage(bytes: Uint8Array, kind: ImageKind, label: string): ImageFormat {
  if (!bytes.length) throw new Error(`${label} is empty`);
  const format = sniffImage(bytes);
  if (!format) throw new Error(`${label} is not a PNG, JPEG, WebP, GIF or SVG image${kind === "favicon" ? " (or an ICO)" : ""}; its content is checked, not its name`);
  if (format === "ico" && kind === "logo") throw new Error(`${label} is an ICO file; the logo takes PNG, JPEG, WebP, GIF or SVG`);
  const limit = maxRawBytes(kind, format);
  if (bytes.length > limit) throw new Error(`${label} is ${kilobytes(bytes.length, Math.ceil)}; the ${kind} must be at most ${kilobytes(limit, Math.floor)} for its type`);
  if (format === "svg") assertSafeSvg(bytes, label);
  return format;
}

export function imageDataUri(bytes: Uint8Array, kind: ImageKind, label: string): string {
  const format = inspectImage(bytes, kind, label);
  return `data:${MIME[format]};base64,${Buffer.from(bytes).toString("base64")}`;
}

const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/;

/** A data URI someone else produced must say what its bytes are, and be what it says. */
export function checkImageDataUri(uri: string, kind: ImageKind, label: string): void {
  const match = DATA_URI.exec(uri);
  if (!match) throw new Error(`${label} must be a base64 data:image/... URI or an https:// URL`);
  const bytes = Buffer.from(match[2]!, "base64");
  const format = inspectImage(bytes, kind, label);
  if (FORMATS_BY_MIME.get(match[1]!) !== format) throw new Error(`${label} says ${match[1]} but its content is ${MIME[format]}`);
}
