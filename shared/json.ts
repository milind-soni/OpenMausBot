/** Plain JSON values — the vocabulary every cross-layer payload that is
 * "just JSON" shares. Single home in shared/; server/schema.ts re-exports
 * under the historical names and keeps the zod helpers. */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

