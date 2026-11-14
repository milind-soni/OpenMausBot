/** Plain JSON values: the vocabulary every cross-layer payload that is "just
 * JSON" shares. */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

