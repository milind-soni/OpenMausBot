// The one place untrusted bytes become domain values.
//
// Everything downstream works on parsed types, so no function in driver.ts or
// capability.ts ever has to ask what shape its argument is. That is the point
// of the boundary: the companion's security rests on the wire being unable to
// name a program, a path or a policy, and that is far easier to audit when the
// vocabulary of the wire is this short.
//
// Same shape as server/schema.ts — a JSON-typed parse followed by a zod schema
// — so the two ends of this protocol are validated the same way.
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON.parse without a reviver can only produce JSON-compatible values. */
function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/** The protocol version this build speaks. */
export const PROTOCOL_VERSION = 1;

const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "invalid expected base-policy digest")
  .brand<"Sha256Digest">();

/** A hex SHA-256 that has already been validated. */
export type Sha256Digest = z.output<typeof digestSchema>;

const versionSchema = z.literal(PROTOCOL_VERSION).optional();

const requestSchema = z.discriminatedUnion("op", [
  z.object({ version: versionSchema, op: z.literal("pause") }),
  z.object({
    version: versionSchema,
    op: z.literal("resume"),
    expectedBasePolicySha256: digestSchema,
  }),
  // reset / validate / activate / run arrive with the server-side task layer.
]);

export type CompanionRequest = z.output<typeof requestSchema>;

export type CompanionResponse =
  | { readonly ok: true; readonly version: number; readonly paused: true }
  | {
      readonly ok: true;
      readonly version: number;
      readonly paused: false;
      readonly capabilitySha256: Sha256Digest;
    }
  | { readonly ok: false; readonly error: string };

/** Brand a digest this process computed itself. */
export function asDigest(hex: string): Sha256Digest {
  return digestSchema.parse(hex);
}

/** Parse one line of the stdio protocol. Throws with a message the caller
 * returns verbatim as `{ok:false,error}`. */
export function parseRequest(line: string): CompanionRequest {
  let payload: JsonValue;
  try {
    payload = parseJson(line);
  } catch {
    throw new Error("invalid JSON");
  }
  const parsed = requestSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // A rejected `op` is the common case and deserves the clearer message; the
  // schema's own text carries the rest (a bad digest, a wrong version).
  throw new Error(
    issue && issue.path[0] !== "op" ? issue.message : "unsupported operation",
  );
}
