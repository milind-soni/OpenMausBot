import { describe, expect, it } from "vitest";
import { ToolCallDetails } from "./tool-call-details.ts";

describe("ToolCallDetails", () => {
  it("keeps a field an update leaves out or sends as null, and replaces content", () => {
    const details = new ToolCallDetails();
    details.record({ toolCallId: "a", title: "Bash", kind: "execute", content: [{ type: "content", content: { type: "text", text: "one" } }] });
    details.record({ toolCallId: "a", title: null, rawInput: { command: "ls" }, content: [] });
    expect(details.merged({ toolCallId: "a" })).toEqual({ title: "Bash", kind: "execute", rawInput: { command: "ls" }, content: [] });
  });

  it("puts the request's own fields over what was recorded and ignores calls it does not name", () => {
    const details = new ToolCallDetails();
    details.record({ toolCallId: "a", title: "Bash", kind: "execute" });
    expect(details.merged({ toolCallId: "a", title: "Run ls", kind: null })).toEqual({ title: "Run ls", kind: "execute" });
    expect(details.merged({ toolCallId: "b", title: "Edit" })).toEqual({ title: "Edit" });
    expect(details.merged({ title: "Edit" })).toEqual({ title: "Edit" });
  });

  it("drops the oldest call past its limit", () => {
    const details = new ToolCallDetails();
    for (let i = 0; i <= 256; i++) details.record({ toolCallId: `c${i}`, title: `t${i}` });
    expect(details.merged({ toolCallId: "c0" })).toEqual({});
    expect(details.merged({ toolCallId: "c1" })).toEqual({ title: "t1" });
    expect(details.merged({ toolCallId: "c256" })).toEqual({ title: "t256" });
  });
});
