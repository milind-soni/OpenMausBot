// Typed turns (Phase 0, item 0.3): the engine-agnostic baseline. The harness
// appends one fixed instruction to the turn text, extracts the last fenced
// JSON block from the reply, and validates it against the schema in code.
// A driver with native constrained decoding may hand over `native`; it is
// validated the same way and never trusted on its own. Missing or invalid
// output is `structured: undefined` with a reason, never a guess.
import { describe, expect, it } from "vitest";

import {
  extractStructuredCandidate,
  resolveStructured,
  stripStructuredBlock,
  structuredInstruction,
  validateStructured,
  withStructuredInstruction,
} from "./typed-turns.ts";

const decision = {
  type: "object",
  properties: {
    status: { enum: ["continue", "completed", "needs-input", "blocked"] },
    next: { type: "string", maxLength: 100 },
    instruction: { type: "string" },
    detail: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

describe("structuredInstruction", () => {
  it("names the schema inline without opening a code fence of its own (an echoing engine must not produce a second block)", () => {
    const text = structuredInstruction(decision);
    expect(text).toContain('"required":["status"]');
    expect(text).not.toContain("```");
    expect(withStructuredInstruction("Do the thing.", decision)).toBe(`Do the thing.\n\n${text}`);
  });
});

describe("extractStructuredCandidate", () => {
  it("takes the last fenced json block, allowing prose before it", () => {
    const text = 'Here is a draft.\n```json\n{"status":"blocked","detail":"old"}\n```\nActually:\n```json\n{"status":"completed","detail":"done"}\n```';
    expect(extractStructuredCandidate(text)).toEqual({ value: { status: "completed", detail: "done" } });
  });

  it("accepts an untagged fence and a bare JSON reply", () => {
    expect(extractStructuredCandidate('```\n{"a":1}\n```')).toEqual({ value: { a: 1 } });
    expect(extractStructuredCandidate('  {"a":1}  ')).toEqual({ value: { a: 1 } });
  });

  it("reports why nothing could be extracted", () => {
    expect(extractStructuredCandidate("just prose")).toEqual({ error: "no fenced JSON block in the reply" });
    expect(extractStructuredCandidate("```json\n{not json}\n```")).toEqual({ error: expect.stringMatching(/^the JSON block does not parse/) });
  });
});

describe("stripStructuredBlock", () => {
  it("removes only the last fenced json block and trims", () => {
    expect(stripStructuredBlock('Ship it.\n```json\n{"status":"completed","detail":"x"}\n```\n')).toBe("Ship it.");
    expect(stripStructuredBlock("no block here")).toBe("no block here");
  });
});

describe("validateStructured", () => {
  it("passes a conforming object", () => {
    expect(validateStructured(decision, { status: "continue", next: "scout", instruction: "verify" })).toEqual([]);
  });

  it("reports type, enum, required and unknown-property violations with a path", () => {
    expect(validateStructured(decision, { status: "later" })).toEqual(['$.status: expected one of "continue", "completed", "needs-input", "blocked"']);
    expect(validateStructured(decision, { detail: "x" })).toEqual(["$: missing required property status"]);
    expect(validateStructured(decision, { status: "blocked", extra: 1 })).toEqual(["$: unexpected property extra"]);
    expect(validateStructured(decision, { status: "blocked", next: 5 })).toEqual(["$.next: expected string"]);
    expect(validateStructured(decision, "nope")).toEqual(["$: expected object"]);
  });

  it("checks arrays, integers, bounds and anyOf", () => {
    const schema = { type: "object", properties: { ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 }, mode: { anyOf: [{ const: "fast" }, { type: "number" }] } } };
    expect(validateStructured(schema, { ids: [1, 2], mode: "fast" })).toEqual([]);
    expect(validateStructured(schema, { ids: [], mode: true })).toEqual(["$.ids: expected at least 1 item", "$.mode: matches none of the allowed shapes"]);
    // a wrong type is reported once; bounds on a value of the wrong type would be noise
    expect(validateStructured(schema, { ids: [0.5] })).toEqual(["$.ids[0]: expected integer"]);
  });
});

describe("resolveStructured", () => {
  it("validates a driver's native object first and falls back to the reply text", () => {
    expect(resolveStructured({ schema: decision, text: "irrelevant", native: { status: "completed", detail: "native" } }))
      .toEqual({ structured: { status: "completed", detail: "native" } });
    expect(resolveStructured({ schema: decision, text: 'ok\n```json\n{"status":"blocked","detail":"text"}\n```', native: { status: "later" } }))
      .toEqual({ structured: { status: "blocked", detail: "text" } });
  });

  it("returns a reason and no object when nothing valid exists", () => {
    expect(resolveStructured({ schema: decision, text: "prose only" }))
      .toEqual({ structuredError: "no fenced JSON block in the reply" });
    expect(resolveStructured({ schema: decision, text: '```json\n{"status":"continue","next":7}\n```' }))
      .toEqual({ structuredError: "invalid: $.next: expected string" });
  });
});
