// The extraction model's typed contract: a field schema in, typed values out, from text or images. The same shape goes to
// Cloud's relay (POST <relay>/v1/extract), so contract.ts checks it on both sides.
import type { DeciderFailure, DeciderProvider } from "../decider/types.ts";

export type FieldType = "string" | "number" | "date" | "boolean" | "enum";
export const FIELD_TYPES: readonly FieldType[] = ["string", "number", "date", "boolean", "enum"];

export interface FieldSpec {
  type: FieldType;
  description?: string;
  /** Required for `enum`, and only there. */
  options?: string[];
}

export type FieldSchema = Record<string, FieldSpec>;

export interface ExtractImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** Base64, no data: prefix. */
  data: string;
}

export interface ExtractInput {
  text?: string;
  images?: ExtractImage[];
}

/** A date is "YYYY-MM-DD". Null when the input does not say. */
export type FieldValue = string | number | boolean | null;
export type ExtractedValues = Record<string, FieldValue>;

/** inboxTriage: the proactive inbox's fixed fields for one email; botExtract: a bot's `extract` tool call. */
export type ExtractSeam = "inboxTriage" | "botExtract" | "keyCheck";

export type ExtractResult =
  | { ok: true; provider: DeciderProvider; values: ExtractedValues; model?: string; latencyMs: number }
  | { ok: false; provider?: DeciderProvider; reason: DeciderFailure; status?: number; latencyMs?: number };

export interface ExtractOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ExtractBackendResult =
  | { ok: true; values: ExtractedValues; model?: string }
  | { ok: false; reason: DeciderFailure; status?: number };

export interface ExtractBackendRequest {
  key: string;
  baseUrl: string;
  accountId?: string;
  model?: string;
  seam: ExtractSeam;
  fields: FieldSchema;
  input: ExtractInput;
  /** Today in the person's zone, so a date written without a year lands right. */
  referenceDate: string;
  signal: AbortSignal;
  fetch: typeof fetch;
}
