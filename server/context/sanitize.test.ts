// What a tool call is allowed to leave behind, permanently.
import { describe, expect, it } from "vitest";

import {
  PATH_LIST_LIMIT,
  TOOL_OUTPUT_LIMIT,
  sanitizeToolObservation,
  type RawToolObservation,
} from "./sanitize.ts";

const raw = (over: Partial<RawToolObservation> = {}): RawToolObservation => ({ name: "Bash", ...over });

describe("sanitizeToolObservation", () => {
  it("keeps the shape of a normal call", () => {
    expect(sanitizeToolObservation(raw({
      callId: "call_1",
      name: "Read",
      input: "server/store.ts",
      output: "export class Store {}",
      ok: true,
      filesRead: ["server/store.ts"],
    }))).toEqual({
      callId: "call_1",
      name: "Read",
      inputSummary: "server/store.ts",
      outputSummary: "export class Store {}",
      ok: true,
      filesRead: ["server/store.ts"],
    });
  });

  it("redacts credentials out of tool output before they become permanent", () => {
    const out = sanitizeToolObservation(raw({
      output: "export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop0123456789",
    }));
    expect(out.outputSummary).not.toContain("sk-ant-abcdefghijklmnop");
    expect(out.outputSummary).toContain("redacted");
  });

  it("redacts a credential passed as tool input", () => {
    const out = sanitizeToolObservation(raw({ input: "curl -H 'Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01'" }));
    expect(out.inputSummary).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01");
  });

  it("strips terminal escapes so replayed output cannot drive a terminal", () => {
    const out = sanitizeToolObservation(raw({ output: "before[31mred after" }));
    expect(out.outputSummary).toBe("before[31mred after");
  });

  it("keeps tabs and newlines, which are content rather than control", () => {
    const out = sanitizeToolObservation(raw({ output: "a\tb\nc" }));
    expect(out.outputSummary).toBe("a\tb\nc");
  });

  it("caps oversized output and says so", () => {
    const out = sanitizeToolObservation(raw({ output: "x".repeat(TOOL_OUTPUT_LIMIT * 3) }));
    expect(out.outputSummary!.length).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT);
    expect(out.clipped).toBe(true);
  });

  it("caps a long path list and says so", () => {
    const paths = Array.from({ length: PATH_LIST_LIMIT + 20 }, (_, i) => `src/file-${i}.ts`);
    const out = sanitizeToolObservation(raw({ filesModified: paths }));
    expect(out.filesModified).toHaveLength(PATH_LIST_LIMIT);
    expect(out.clipped).toBe(true);
  });

  it("leaves `clipped` off entirely when nothing was cut", () => {
    expect(sanitizeToolObservation(raw({ output: "short" })).clipped).toBeUndefined();
  });

  it("is idempotent — a second pass changes nothing", () => {
    const first = sanitizeToolObservation(raw({
      name: "Bash",
      input: "echo $OPENAI_API_KEY",
      output: "sk-proj-abcdefghijklmnop0123456789 " + "y".repeat(TOOL_OUTPUT_LIMIT * 2),
      ok: false,
      filesModified: ["a.ts", "b.ts"],
    }));
    const second = sanitizeToolObservation({
      callId: first.callId,
      name: first.name,
      input: first.inputSummary,
      output: first.outputSummary,
      ok: first.ok,
      filesModified: first.filesModified,
    });
    // `clipped` is a property of the first pass; everything carried forward
    // must survive the round trip byte for byte
    expect(second.outputSummary).toBe(first.outputSummary);
    expect(second.inputSummary).toBe(first.inputSummary);
    expect(second.filesModified).toEqual(first.filesModified);
  });

  it("records a failed call, including one with no output at all", () => {
    expect(sanitizeToolObservation(raw({ name: "Edit", ok: false }))).toEqual({ name: "Edit", ok: false });
  });

  it("never drops a call for want of a name", () => {
    expect(sanitizeToolObservation(raw({ name: "   " })).name).toBe("tool");
  });

  it("omits empty fields rather than storing blanks", () => {
    const out = sanitizeToolObservation(raw({ input: "", output: "", filesRead: [] }));
    expect(out).toEqual({ name: "Bash" });
  });
});
