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

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "invalid id");

const requestSchema = z.discriminatedUnion("op", [
  z.object({ version: versionSchema, op: z.literal("pause") }),
  z.object({
    version: versionSchema,
    op: z.literal("resume"),
    expectedBasePolicySha256: digestSchema,
  }),
  // The task operations. Note what these can and cannot say: a task id, a
  // digest, an instant, a command id. Never an executable, argv, working
  // directory, environment variable, path, policy or capability document —
  // every one of those is read back out of the staged manifest the digest
  // pins, so the wire can select an approved action but never describe a new
  // one.
  z.object({
    version: versionSchema,
    op: z.literal("reset"),
    taskId: idSchema,
    expectedBasePolicySha256: digestSchema,
  }),
  z.object({
    version: versionSchema,
    op: z.literal("validate"),
    taskId: idSchema,
    manifestSha256: digestSchema,
  }),
  z.object({
    version: versionSchema,
    op: z.literal("activate"),
    taskId: idSchema,
    manifestSha256: digestSchema,
    /** The instant the control plane derived the capability. A CUA manifest's
     * lifetimes are relative, so both ends need the same one to agree on a
     * digest; task.ts bounds how far it may sit from the worker's own clock. */
    issuedAt: z.number().int().positive(),
    expectedCapabilitySha256: digestSchema,
  }),
  z.object({
    version: versionSchema,
    op: z.literal("run"),
    taskId: idSchema,
    manifestSha256: digestSchema,
    commandId: idSchema,
  }),
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
  | {
      readonly ok: true;
      readonly version: number;
      readonly op: "validate";
      /** The task root this worker derived for itself. The control plane needs
       * the exact string to rebuild the same capability document, and cannot
       * know the worker account's home directory any other way. It is a hint,
       * not an authority: `activate` rebuilds the capability against this
       * worker's own root, so a report that does not match simply fails. */
      readonly taskRoot: string;
      readonly files: number;
      readonly commandIds: readonly string[];
    }
  | {
      readonly ok: true;
      readonly version: number;
      readonly op: "activate" | "reset";
      readonly capabilitySha256: Sha256Digest;
    }
  | {
      readonly ok: true;
      readonly version: number;
      readonly op: "run";
      readonly commandId: string;
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly ok: false; readonly error: string };

/** The reply to a `stage` invocation, which is a subcommand rather than a wire
 * operation because its payload is a raw byte stream. */
export type StageResponse =
  | { readonly ok: true; readonly version: number; readonly op: "stage"; readonly files: number }
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
