import { describe, expect, it, vi } from "vitest";

import { extractRequestProblem, parseExtractResponse, parseExtractValues } from "./contract.ts";
import type { FieldSchema, FieldSpec } from "./types.ts";
import { extractWithWorkersAi } from "./workers-ai.ts";

describe("extraction fields that overlap Object.prototype", () => {
  it.each(["constructor", "toString", "hasOwnProperty"])("treats a missing %s field as null", (name) => {
    const fields: FieldSchema = { [name]: { type: "string" } };
    expect(extractRequestProblem(fields, { text: "Read the named field." })).toBeNull();
    expect(parseExtractValues({}, fields)).toEqual({ [name]: null });
  });

  it.each(["a literal field value", null])("preserves an own __proto__ field with value %s through JSON", (value) => {
    const fields: FieldSchema = { ["__proto__"]: { type: "string" } };
    const response = parseExtractResponse({ values: JSON.parse(JSON.stringify({ ["__proto__"]: value })) }, fields);
    expect(response).not.toBeNull();
    expect(Object.hasOwn(response!.values, "__proto__")).toBe(true);
    expect(response!.values["__proto__"]).toBe(value);
    expect(Object.getPrototypeOf(response!.values)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(response!.values))).toEqual({ ["__proto__"]: value });
  });

  it("retains ordinary typed values, missing nulls, and rejection of mistyped fields", () => {
    const fields: FieldSchema = { amount: { type: "number" }, note: { type: "string" } };
    expect(parseExtractValues({ amount: 12, extra: "ignored" }, fields)).toEqual({ amount: 12, note: null });
    expect(parseExtractValues({ amount: "12" }, fields)).toBeNull();
  });

  it.each([
    ["__proto__", { type: "string" }, "a literal field value"],
    ["__proto__", { type: "number" }, 42],
    ["__proto__", { type: "date" }, "2026-10-27"],
    ["__proto__", { type: "boolean" }, false],
    ["__proto__", { type: "enum", options: ["__proto__", "other"] }, "__proto__"],
    ["constructor", { type: "boolean" }, false],
  ] satisfies Array<[string, FieldSpec, string | number | boolean]>)("round-trips %s through Workers AI for %j", async (name, spec, expected) => {
    const fields: FieldSchema = { [name]: spec };
    const usesClef = spec.type === "boolean" || spec.type === "enum";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      expect(Object.hasOwn(usesClef ? sent.questions : sent.fields, name)).toBe(true);
      const answer = spec.type === "boolean" ? { type: "noul", noul: 0.1 }
        : spec.type === "enum" ? { type: "choice", choice: expected, probabilities: { ["__proto__"]: 0.9, other: 0.1 } }
          : { type: spec.type, value: expected };
      return Response.json({ result: { answers: { [name]: answer } }, success: true });
    });
    const result = await extractWithWorkersAi({
      key: "unit-test-token", baseUrl: "https://api.cloudflare.com/client/v4", accountId: "a".repeat(32),
      seam: "botExtract", fields, input: { text: "Read the named field." }, referenceDate: "2026-10-27",
      signal: new AbortController().signal, fetch,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an extracted value");
    expect(result.values[name]).toBe(expected);
    expect(Object.hasOwn(result.values, name)).toBe(true);
    expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
  });
});
