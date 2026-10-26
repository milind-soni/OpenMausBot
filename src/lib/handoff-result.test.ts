import { describe, expect, it } from "vitest";

import { handoffResult } from "./handoff-result";

const result = (output: string | undefined) =>
  ({ roomRequest: { id: "h1", phase: "result" as const }, tool: { name: "Mira replied", ok: true, output } });

describe("handoffResult", () => {
  it("previews the first line and keeps the rest of the reply", () => {
    expect(handoffResult(result("  Tests pass on main.\n\nDetails: 412 passed.\n"))).toEqual({
      preview: "Tests pass on main.",
      more: "Details: 412 passed.",
    });
  });

  it("has nothing more for a one-line reply", () => {
    expect(handoffResult(result("Done."))?.more).toBeNull();
  });

  it("shortens a long first line and keeps the whole reply behind it", () => {
    const long = "x".repeat(300);
    const reply = handoffResult(result(`${long}\nsecond`))!;
    expect(reply.preview).toHaveLength(140);
    expect(reply.preview.endsWith("…")).toBe(true);
    expect(reply.more).toBe(`${long}\nsecond`);
  });

  it("ignores rows without a reply", () => {
    expect(handoffResult(result(undefined))).toBeNull();
    expect(handoffResult(result("   \n "))).toBeNull();
  });

  it("ignores the request row and plain activity", () => {
    expect(handoffResult({ roomRequest: { id: "h1", phase: "request" }, tool: { name: "Sent to Mira", ok: true, output: "why" } })).toBeNull();
    expect(handoffResult({ tool: { name: "Read file", ok: true, output: "contents" } })).toBeNull();
  });
});
