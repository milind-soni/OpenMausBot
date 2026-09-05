import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import { BOT_INSTRUCTIONS_MAX_CHARS } from "./team-manifest.ts";

/** Reverse-engineered anonymous public-profile transport; the upstream API is undocumented. */
export const GROK_BOT_TEMPLATE_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.GrokBotService/GetPublicGrokBotTemplate";
export const GROK_BOT_RESPONSE_MAX_BYTES = 128 * 1024;
export const GROK_BOT_INSTRUCTION_MAX_CHARS = BOT_INSTRUCTIONS_MAX_CHARS;
export const GROK_BOT_TIMEOUT_MS = 10_000;
const GROK_BOT_MAX_FIELDS_PER_MESSAGE = 256;
const GROK_BOT_MAX_TEXT_BYTES = GROK_BOT_INSTRUCTION_MAX_CHARS * 4;
const GROK_BOT_MAX_SHORT_TEXT_BYTES = 1_024;
const GROK_BOT_MAX_NESTING = 16;

export interface ParsedGrokBotUrl {
  id: string;
}

export interface GrokBotTemplate {
  shareId: string;
  name: string;
  avatarShape?: string;
  avatarColor?: string;
  published: boolean;
  activeVersion?: string;
  description: string;
}

export interface GrokBotTemplateResponse {
  template: GrokBotTemplate;
  ownerDisplayName?: string;
}

/** Create the stable client error used for invalid public Grok Bot URLs. */
function throwGrokBotUrlError(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/** Accept only the exact public HTTPS URL supported by this importer. */
export function parseGrokBotUrl(input: string): ParsedGrokBotUrl {
  if (typeof input !== "string") throwGrokBotUrlError("Enter a public Grok Bot link");
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throwGrokBotUrlError("Enter a public Grok Bot link");
  }

  const authority = raw.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (
    url.protocol !== "https:" ||
    url.hostname !== "x.ai" ||
    authority.includes(":") ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throwGrokBotUrlError("Only exact public x.ai Grok Bot links are supported");
  }

  const match = url.pathname.match(/^\/bot\/([A-Za-z0-9_-]{21})$/);
  if (!match) throwGrokBotUrlError("The x.ai link must point to a public Grok Bot");
  return { id: match[1]! };
}

/** Read the bounded protobuf wire values returned by the public profile endpoint. */
class ProtoReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Report whether the reader has consumed the complete input buffer. */
  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  /** Read a protobuf varint and reject truncated or unsafe numeric values. */
  readVarint(): number {
    let value = 0;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated protobuf");
      const byte = this.bytes[this.offset++]!;
      if (index === 9 && byte > 1) throw new Error("invalid protobuf varint");
      value += (byte & 0x7f) * 2 ** (7 * index);
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error("invalid protobuf varint");
        return value;
      }
    }
    throw new Error("invalid protobuf varint");
  }

  /** Read one length-delimited field without exceeding its byte budget. */
  readBytes(maxBytes = GROK_BOT_RESPONSE_MAX_BYTES): Uint8Array {
    const length = this.readVarint();
    if (!Number.isSafeInteger(length) || length > maxBytes) throw new Error("protobuf field is too large");
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error("truncated protobuf");
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  /** Decode one bounded length-delimited field as strict UTF-8 text. */
  readString(maxBytes = GROK_BOT_MAX_TEXT_BYTES): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.readBytes(maxBytes));
    } catch {
      throw new Error("invalid protobuf text");
    }
  }

  /** Advance over a fixed-width protobuf field after checking its bounds. */
  readFixed(length: 4 | 8): void {
    if (this.offset + length > this.bytes.length) throw new Error("truncated protobuf");
    this.offset += length;
  }

  /** Read a protobuf field number together with its wire type. */
  readKey(): { field: number; wireType: number } {
    const key = this.readVarint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (!Number.isSafeInteger(field) || field < 1) throw new Error("invalid protobuf field key");
    return { field, wireType };
  }
}

/** Skip an unknown protobuf field while enforcing supported wire and nesting limits. */
function skipField(reader: ProtoReader, field: number, wireType: number, depth = 0): void {
  if (depth > GROK_BOT_MAX_NESTING) throw new Error("protobuf nesting is too deep");
  if (wireType === 0) {
    reader.readVarint();
    return;
  }
  if (wireType === 1) {
    reader.readFixed(8);
    return;
  }
  if (wireType === 2) {
    reader.readBytes();
    return;
  }
  if (wireType === 3) {
    for (;;) {
      if (reader.done) throw new Error("truncated protobuf group");
      const nested = reader.readKey();
      if (nested.wireType === 4) {
        if (nested.field !== field) throw new Error("invalid protobuf group");
        return;
      }
      skipField(reader, nested.field, nested.wireType, depth + 1);
    }
  }
  if (wireType === 4) throw new Error("unexpected protobuf group end");
  if (wireType === 5) {
    reader.readFixed(4);
    return;
  }
  throw new Error("unsupported protobuf wire type");
}

/** Enforce the maximum number of fields accepted in one protobuf message. */
function assertFieldBudget(count: number): void {
  if (count > GROK_BOT_MAX_FIELDS_PER_MESSAGE) throw new Error("protobuf has too many fields");
}

/** Decode the nested public-profile template message. */
function decodeTemplate(bytes: Uint8Array): GrokBotTemplate {
  const reader = new ProtoReader(bytes);
  let shareId: string | undefined;
  let name: string | undefined;
  let avatarShape: string | undefined;
  let avatarColor: string | undefined;
  let published: boolean | undefined;
  let activeVersion: string | undefined;
  let description: string | undefined;
  const seen = new Set<number>();
  let fieldCount = 0;

  while (!reader.done) {
    assertFieldBudget(++fieldCount);
    const { field, wireType } = reader.readKey();
    if (field === 1 || field === 2 || field === 3 || field === 4 || field === 12) {
      if (wireType !== 2 || seen.has(field)) throw new Error("invalid Grok Bot text field");
      seen.add(field);
      const value = reader.readString(field === 12 ? GROK_BOT_MAX_TEXT_BYTES : GROK_BOT_MAX_SHORT_TEXT_BYTES);
      if (field === 1) shareId = value;
      else if (field === 2) name = value;
      else if (field === 3) avatarShape = value;
      else if (field === 4) avatarColor = value;
      else description = value;
      continue;
    }
    if (field === 10) {
      if (wireType !== 0 || seen.has(field)) throw new Error("invalid Grok Bot published field");
      seen.add(field);
      const value = reader.readVarint();
      if (value !== 0 && value !== 1) throw new Error("invalid Grok Bot published value");
      published = value === 1;
      continue;
    }
    if (field === 11) {
      if (seen.has(field)) throw new Error("duplicate Grok Bot field");
      seen.add(field);
      if (wireType === 2) activeVersion = reader.readString(GROK_BOT_MAX_SHORT_TEXT_BYTES);
      else skipField(reader, field, wireType);
      continue;
    }
    skipField(reader, field, wireType);
  }

  if (shareId === undefined || name === undefined || published === undefined || description === undefined) {
    throw new Error("Grok Bot response is missing required fields");
  }
  return { shareId, name, avatarShape, avatarColor, published, activeVersion, description };
}

/** Decode the top-level public Grok Bot response message. */
function decodeResponse(bytes: Uint8Array): GrokBotTemplateResponse {
  const reader = new ProtoReader(bytes);
  let template: GrokBotTemplate | undefined;
  let ownerDisplayName: string | undefined;
  const seen = new Set<number>();
  let fieldCount = 0;
  while (!reader.done) {
    assertFieldBudget(++fieldCount);
    const { field, wireType } = reader.readKey();
    if (field === 1) {
      if (wireType !== 2 || seen.has(field)) throw new Error("invalid Grok Bot template field");
      seen.add(field);
      template = decodeTemplate(reader.readBytes());
    } else if (field === 2) {
      if (wireType !== 2 || seen.has(field)) throw new Error("invalid Grok Bot owner field");
      seen.add(field);
      ownerDisplayName = reader.readString(GROK_BOT_MAX_SHORT_TEXT_BYTES);
    } else {
      skipField(reader, field, wireType);
    }
  }
  if (!template) throw new Error("Grok Bot response has no template");
  return { template, ownerDisplayName };
}

/** Encode the requested share ID as the endpoint's protobuf request body. */
function encodeShareId(shareId: string): Uint8Array {
  const value = new TextEncoder().encode(shareId);
  const result = new Uint8Array(2 + value.length);
  result[0] = 0x0a;
  result[1] = value.length;
  result.set(value, 2);
  return result;
}

/** Read the response body with both announced and actual byte limits enforced. */
async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > GROK_BOT_RESPONSE_MAX_BYTES) {
    throw new Error("Grok Bot response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > GROK_BOT_RESPONSE_MAX_BYTES) throw new Error("Grok Bot response is too large");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Fetch and decode one public Grok Bot template without authentication. */
export async function fetchGrokBotTemplate(input: string, fetcher: typeof fetch = fetch): Promise<GrokBotTemplateResponse> {
  const { id } = parseGrokBotUrl(input);
  let response: Response;
  try {
    response = await fetcher(GROK_BOT_TEMPLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
      },
      body: encodeShareId(id),
      redirect: "error",
      signal: AbortSignal.timeout(GROK_BOT_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Grok Bot request failed");
  }
  if (!response.ok) throw new Error("Grok Bot request failed");
  try {
    return decodeResponse(await readResponseBytes(response));
  } catch (error) {
    if (error instanceof Error && error.message === "Grok Bot response is too large") throw error;
    throw new Error("Grok Bot response is invalid");
  }
}

/** Validate the fetched profile identity and normalize its public text fields. */
function publicTemplate(response: GrokBotTemplateResponse, expectedShareId: string): GrokBotTemplate {
  const template = response.template;
  if (template.shareId !== expectedShareId) throw new Error("Grok Bot response is invalid");
  const name = template.name.trim();
  const description = template.description.trim();
  if (!template.published) throw new Error("Grok Bot profile is unpublished");
  if (!description) throw new Error("Grok Bot public instructions are empty");
  if (template.description.length > GROK_BOT_INSTRUCTION_MAX_CHARS || description.length > GROK_BOT_INSTRUCTION_MAX_CHARS) {
    throw new Error("Grok Bot public instructions are too large");
  }
  if (!name || name.length > 100) throw new Error("Grok Bot response is invalid");
  return { ...template, name, description };
}

const MAUS_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;

/** Convert a validated public Grok Bot profile into an OpenMaus package. */
export function grokBotTemplateToPackage(
  template: GrokBotTemplate,
  expectedShareId = template.shareId,
  ownerDisplayName?: string,
): ParsedBotPackage {
  const publicProfile = publicTemplate({ template, ownerDisplayName }, expectedShareId);
  const publicColor = publicProfile.avatarColor?.trim().toLowerCase();
  const importedColor = MAUS_COLORS.find((color) => color === publicColor) ?? "blue";
  const author = ownerDisplayName?.trim();
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: {
      id: `grok-${publicProfile.shareId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      release: "1.0.0",
      name: publicProfile.name,
      tagline: "Public Grok Bot profile instructions",
      summary: "Imported from the public Grok Bot profile.",
      category: "Grok Bot",
      author: { name: author && author.length <= 100 ? author : "Grok" },
      license: "Public profile",
      outcomes: ["Follow the public profile instructions."],
      setupMinutes: 1,
      requirements: { apps: [], capabilities: [] },
      agents: [{
        key: "grok-bot",
        name: publicProfile.name,
        title: "Grok Bot",
        description: publicProfile.description,
        appearance: {
          color: importedColor,
        },
      }],
    },
  });
}

/** Fetch a public Grok Bot profile and return its importable OpenMaus package. */
export async function fetchGrokBotPackage(input: string, fetcher: typeof fetch = fetch): Promise<ParsedBotPackage> {
  const { id } = parseGrokBotUrl(input);
  const response = await fetchGrokBotTemplate(input, fetcher);
  return grokBotTemplateToPackage(response.template, id, response.ownerDisplayName);
}
