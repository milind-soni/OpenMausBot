import { describe, expect, it } from "vitest";

import { compileServerToolSchema, serverToolValidator } from "./mcp-schema-validator.ts";

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#", type: "object",
  properties: { country: { type: "string" }, postal: { type: "string" } },
  dependencies: {
    country: {
      properties: { postal: { type: "string", pattern: "^[0-9]{5}$", example: "12345" } },
      required: ["postal"],
    },
    postal: ["country"],
  },
};

describe("annotations inside draft-07 schema dependencies", () => {
  it("compiles the schema after removing non-asserting generator hints", () => {
    const validate = compileServerToolSchema(schema);
    expect(validate({ country: "US", postal: "12345" })).toBe(true);
    expect(validate({ country: "US", postal: "letters" })).toBe(false);
    expect(validate({ country: "US" })).toBe(false);
    expect(validate({ postal: "12345" })).toBe(false);
    expect(validate({})).toBe(true);
  });

  it("keeps the server tool on full validation instead of dropping its pattern", () => {
    const checked = serverToolValidator(schema);
    expect(checked.check).toBe("full");
    expect(checked.validate({ country: "US", postal: "letters" })).toBe(false);
  });

  it("does not remove dependency property names that also name annotations", () => {
    const validate = compileServerToolSchema({
      type: "object", properties: { example: { type: "boolean" }, detail: { type: "string" } },
      dependencies: { example: { required: ["detail"], "x-generator-note": "required together" } },
    });
    expect(validate({ example: true })).toBe(false);
    expect(validate({ example: true, detail: "present" })).toBe(true);
  });
});
