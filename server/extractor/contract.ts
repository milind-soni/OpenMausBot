// POST <OMB_CLOUD_DECIDER_URL>/v1/extract, shared with Cloud's Admin through fixtures/extract-relay.json: change both
// together. { seam, fields, input } → { values, model }. A request that breaks a rule here never goes through the
// included token, and an answer that breaks one is malformed: a value is never taken on trust.
import type { ExtractedValues, ExtractImage, ExtractInput, ExtractSeam, FieldSchema, FieldSpec, FieldType, FieldValue } from "./types.ts";
import { FIELD_TYPES } from "./types.ts";

export const EXTRACT_PATH = "/v1/extract";
export const EXTRACT_LIMITS = {
  /** The JSON body with each image's base64 counted as empty: images have their own cap. */
  bodyBytesWithoutImages: 256 * 1024,
  images: 4,
  /** Decoded bytes per image. */
  imageBytes: 1024 * 1024,
  fields: 30,
  fieldName: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  description: 300,
  options: 50,
  option: 100,
  /** Characters of input text. */
  text: 200_000,
} as const;
export const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const SEAMS: ReadonlySet<string> = new Set<ExtractSeam>(["inboxTriage", "botExtract", "keyCheck"]);

export const EXTRACT_KEY_CHECK = {
  fields: { ok: { type: "boolean", description: "Is this a connection check?" } } satisfies FieldSchema,
  input: { text: "OpenMausBot is checking that an extraction-model key works." },
};

/** The proactive inbox reads these from one email, and the relay takes inbox triage only with exactly these. */
export const INBOX_KINDS = ["personal", "work", "newsletter", "receipt", "notification", "marketing", "other"];
export const INBOX_FIELDS: FieldSchema = {
  sender: { type: "string", description: "Who sent it: the person's or the company's name." },
  ask: { type: "string", description: "What the sender asks the reader to do, in a few words." },
  deadline: { type: "date", description: "When what is asked for is due, if a date is given." },
  amount: { type: "number", description: "An amount of money the email is about, if any." },
  needs_reply: { type: "boolean", description: "Does the sender wait on a written reply from the reader?" },
  kind: { type: "enum", description: "What kind of email this is.", options: INBOX_KINDS },
};
export const INBOX_TEXT_MAX = 8_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function fieldProblem(name: string, spec: unknown): string | null {
  if (!EXTRACT_LIMITS.fieldName.test(name)) return `field name ${JSON.stringify(name.slice(0, 70))} must be letters, digits or _ and start with a letter`;
  if (!isRecord(spec) || !FIELD_TYPES.includes(spec.type as FieldType)) return `${name}: type must be one of ${FIELD_TYPES.join(", ")}`;
  if (Object.keys(spec).some((key) => key !== "type" && key !== "description" && key !== "options")) return `${name}: only type, description and options`;
  if (spec.description !== undefined && (typeof spec.description !== "string" || spec.description.length > EXTRACT_LIMITS.description)) {
    return `${name}: description must be text of at most ${EXTRACT_LIMITS.description} characters`;
  }
  if (spec.type !== "enum") return spec.options === undefined ? null : `${name}: options are for enum fields only`;
  const options = spec.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > EXTRACT_LIMITS.options) return `${name}: an enum needs 2 to ${EXTRACT_LIMITS.options} options`;
  if (!options.every((option) => typeof option === "string" && option.trim() && option.length <= EXTRACT_LIMITS.option)) return `${name}: each option is text of at most ${EXTRACT_LIMITS.option} characters`;
  return new Set(options).size === options.length ? null : `${name}: options must differ`;
}

function imageProblem(image: unknown, index: number): string | null {
  if (!isRecord(image) || Object.keys(image).some((key) => key !== "mime" && key !== "data")) return `images[${index}] must be {mime, data}`;
  if (typeof image.mime !== "string" || !IMAGE_MIMES.has(image.mime)) return `images[${index}]: a PNG, JPEG or WebP image`;
  if (typeof image.data !== "string" || !image.data || !BASE64.test(image.data)) return `images[${index}]: data must be base64`;
  return base64Bytes(image.data) <= EXTRACT_LIMITS.imageBytes ? null : `images[${index}] is over 1 MB`;
}

/** The first rule a request breaks, in words a bot can act on; null when it fits. Every seam's request obeys these. */
export function extractRequestProblem(fields: unknown, input: unknown): string | null {
  if (!isRecord(fields)) return "fields must be an object of field name to {type, description?, options?}";
  const names = Object.keys(fields);
  if (!names.length || names.length > EXTRACT_LIMITS.fields) return `give 1 to ${EXTRACT_LIMITS.fields} fields`;
  for (const name of names) {
    const problem = fieldProblem(name, fields[name]);
    if (problem) return problem;
  }
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "text" && key !== "images")) return "input must be {text?, images?}";
  if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > EXTRACT_LIMITS.text)) return `text must be at most ${EXTRACT_LIMITS.text} characters`;
  const images = input.images;
  if (images !== undefined && (!Array.isArray(images) || images.length > EXTRACT_LIMITS.images)) return `at most ${EXTRACT_LIMITS.images} images`;
  for (const [index, image] of (images ?? []).entries()) {
    const problem = imageProblem(image, index);
    if (problem) return problem;
  }
  if (!(typeof input.text === "string" && input.text.trim()) && !(images?.length)) return "give text or an image to read";
  const withoutImages = { fields, input: { ...input, ...(images ? { images: (images as ExtractImage[]).map((image) => ({ mime: image.mime, data: "" })) } : {}) } };
  return Buffer.byteLength(JSON.stringify(withoutImages)) <= EXTRACT_LIMITS.bodyBytesWithoutImages ? null : "the request is over 256 KB without its images";
}

const sameSchema = (fields: FieldSchema, expected: FieldSchema): boolean => JSON.stringify(fields) === JSON.stringify(expected);

/** Whether Cloud's relay takes this request: the general rules, then the seam's own shape. */
export function relayAcceptsExtract(seam: ExtractSeam, fields: FieldSchema, input: ExtractInput): boolean {
  try {
    if (!SEAMS.has(seam) || extractRequestProblem(fields, input) !== null) return false;
    if (seam === "keyCheck") return sameSchema(fields, EXTRACT_KEY_CHECK.fields) && JSON.stringify(input) === JSON.stringify(EXTRACT_KEY_CHECK.input);
    if (seam === "inboxTriage") return sameSchema(fields, INBOX_FIELDS) && !input.images && typeof input.text === "string" && input.text.length <= INBOX_TEXT_MAX;
    return true;
  } catch {
    return false;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One value of the field's type, or null; undefined when it is not. */
export function typedValue(spec: FieldSpec, value: unknown): FieldValue | undefined {
  if (value === null || value === undefined) return null;
  switch (spec.type) {
    case "string": return typeof value === "string" ? value : undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "date": return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : undefined;
    case "enum": return typeof value === "string" && spec.options?.includes(value) ? value : undefined;
  }
}

/** `values` for exactly the fields asked: a missing one is null, a mistyped one makes the whole answer malformed. */
export function parseExtractValues(values: unknown, fields: FieldSchema): ExtractedValues | null {
  if (!isRecord(values)) return null;
  const out: ExtractedValues = {};
  for (const [name, spec] of Object.entries(fields)) {
    const typed = typedValue(spec, values[name]);
    if (typed === undefined) return null;
    out[name] = typed;
  }
  return out;
}

/** The relay's answer: { values, model }. */
export function parseExtractResponse(body: unknown, fields: FieldSchema): { values: ExtractedValues; model?: string } | null {
  if (!isRecord(body)) return null;
  const values = parseExtractValues(body.values, fields);
  if (!values) return null;
  const model = typeof body.model === "string" && body.model.length <= 80 ? body.model : undefined;
  return { values, ...(model ? { model } : {}) };
}
