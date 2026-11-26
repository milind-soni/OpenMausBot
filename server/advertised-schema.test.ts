import { describe, expect, it } from "vitest";

import { compactAdvertisedSchema } from "./advertised-schema.ts";

describe("a schema as a model is shown it", () => {
  it("leaves out additionalProperties: true, and keeps false", () => {
    expect(compactAdvertisedSchema({ type: "object", additionalProperties: true, properties: { a: { type: "object", additionalProperties: true } } }))
      .toEqual({ type: "object", properties: { a: { type: "object" } } });
    expect(compactAdvertisedSchema({ type: "object", additionalProperties: false })).toEqual({ type: "object", additionalProperties: false });
    expect(compactAdvertisedSchema({ type: "object", additionalProperties: { type: "string" } })).toEqual({ type: "object", additionalProperties: { type: "string" } });
  });

  it("leaves out bounds at the safe-integer limits, and keeps every other bound", () => {
    const count = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
    expect(compactAdvertisedSchema({ type: "object", properties: { count } })).toEqual({ type: "object", properties: { count: { type: "integer" } } });
    expect(compactAdvertisedSchema({ type: "integer", minimum: 0, maximum: 9_007_199_254_740_990 })).toEqual({ type: "integer", minimum: 0, maximum: 9_007_199_254_740_990 });
  });

  it("flattens an anyOf nested in an anyOf", () => {
    expect(compactAdvertisedSchema({ anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "boolean" }] }))
      .toEqual({ anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] });
  });

  it("leaves out a JSON-text fallback beside the shape it stands for, and keeps a JSON-text value that is the only one", () => {
    const shape = { type: "object", properties: { a: { type: "string" } } };
    expect(compactAdvertisedSchema({ anyOf: [shape, { type: "string", contentMediaType: "application/json" }] })).toEqual(shape);
    const only = { type: "string", contentMediaType: "application/json" };
    expect(compactAdvertisedSchema({ anyOf: [only] })).toEqual(only);
  });

  it("leaves out the null branch of a property that may be left out, and keeps it on a required one", () => {
    const nullable = { anyOf: [{ type: "string", maxLength: 10 }, { type: "null" }], description: "A note." };
    expect(compactAdvertisedSchema({ type: "object", properties: { optional: nullable, needed: nullable }, required: ["needed"] })).toEqual({
      type: "object", required: ["needed"],
      properties: { optional: { type: "string", maxLength: 10, description: "A note." }, needed: { anyOf: [{ type: "string", maxLength: 10 }, { type: "null" }], description: "A note." } },
    });
  });

  it("makes a tagged union of objects one object: the tag lists every value, and only what every branch requires stays required", () => {
    const schema = { anyOf: [
      { type: "object", properties: { kind: { const: "file" }, path: { type: "string" }, mode: { type: "string" } }, required: ["kind", "path", "mode"] },
      { type: "object", properties: { kind: { type: "string", enum: ["url"] }, url: { type: "string" }, mode: { type: "number" } }, required: ["kind", "url", "mode"] },
    ] };
    expect(compactAdvertisedSchema(schema)).toEqual({ type: "object", required: ["kind", "mode"], properties: {
      kind: { type: "string", enum: ["file", "url"] }, path: { type: "string" }, mode: { anyOf: [{ type: "string" }, { type: "number" }] }, url: { type: "string" },
    } });
  });

  it("keeps a union that is not tagged, and every value, enum and required field as written", () => {
    const untagged = { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }] };
    expect(compactAdvertisedSchema(untagged)).toEqual(untagged);
    const values = { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["a", "b"], default: "a", examples: [{ additionalProperties: true }] } } };
    expect(compactAdvertisedSchema(values)).toEqual(values);
  });

  it("does not change the schema it was given", () => {
    const schema = { type: "object", additionalProperties: true, properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    const copy = structuredClone(schema);
    compactAdvertisedSchema(schema);
    expect(schema).toEqual(copy);
  });
});
