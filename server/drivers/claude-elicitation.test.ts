import { describe, expect, it } from "vitest";
import { claudeElicitations } from "./claude-elicitation.ts";

function harness() {
  const written: any[] = [];
  const events: any[] = [];
  const elicit = claudeElicitations((frame) => written.push(frame), (event) => events.push(event));
  return { elicit, written, events };
}

const ask = (id: string, request: Record<string, unknown> = {}) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "elicitation", mcp_server_name: "github", message: "Allow access to your repos?", mode: "form", requested_schema: { type: "object", properties: {} }, ...request },
});
const sent = (id: string, response: unknown) => ({ type: "control_response", response: { subtype: "success", request_id: id, response } });
const done = (id: string, behavior: string, source: string) => ({ type: "request.resolved", requestId: `elicitation:${id}`, behavior, source });

describe("claudeElicitations", () => {
  it("turns a plain confirmation into an approval card and accepts it", () => {
    const { elicit, written, events } = harness();
    expect(elicit.frame(ask("e1"))).toBe(true);
    expect(written).toEqual([]);
    expect(events).toEqual([{
      type: "request.opened",
      requestId: "elicitation:e1",
      requestType: "permission",
      tool: "mcp__github",
      summary: "github: Allow access to your repos?",
      requiresExplicitApproval: true,
    }]);
    expect(elicit.answer("elicitation:e1", "allow")).toBe(true);
    expect(written).toEqual([sent("e1", { action: "accept", content: {} })]);
    expect(events.at(-1)).toEqual(done("e1", "allow", "user"));
    expect(elicit.answer("elicitation:e1", "allow")).toBe(false);
  });

  it("declines when the person declines", () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e2"));
    expect(elicit.answer("elicitation:e2", "deny")).toBe(true);
    expect(written).toEqual([sent("e2", { action: "decline" })]);
    expect(events.at(-1)).toEqual(done("e2", "deny", "user"));
  });

  it("withdraws the card when the CLI cancels the question", () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e3"));
    expect(elicit.frame({ type: "control_cancel_request", request_id: "e3" })).toBe(true);
    expect(events.at(-1)).toEqual(done("e3", "deny", "timeout"));
    expect(elicit.answer("elicitation:e3", "allow")).toBe(false);
    expect(written).toEqual([]);
    expect(elicit.frame({ type: "control_cancel_request", request_id: "other" })).toBe(false);
  });

  it("declines a form with fields at once and says why", () => {
    const { elicit, written, events } = harness();
    expect(elicit.frame(ask("e4", { requested_schema: { type: "object", properties: { token: { type: "string" } } } }))).toBe(true);
    expect(written).toEqual([sent("e4", { action: "decline" })]);
    expect(events).toEqual([{ type: "runtime.notice", message: expect.stringContaining("github asked you to fill in a field") }]);
  });

  it("declines a link request and passes on only a web link", () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e5", { mode: "url", url: "https://example.com/auth" }));
    elicit.frame(ask("e6", { mode: "url", url: "javascript:alert(1)" }));
    expect(written).toEqual([sent("e5", { action: "decline" }), sent("e6", { action: "decline" })]);
    expect(events[0].message).toContain(": https://example.com/auth.");
    expect(events[1].message).not.toContain("javascript:");
  });

  it("withdraws every open card when the session closes", () => {
    const { elicit, events } = harness();
    elicit.frame(ask("a"));
    elicit.frame(ask("b"));
    elicit.close();
    expect(events.slice(-2)).toEqual([done("a", "deny", "system"), done("b", "deny", "system")]);
    expect(elicit.answer("elicitation:a", "allow")).toBe(false);
  });

  it("leaves other frames and cards alone", () => {
    const { elicit } = harness();
    expect(elicit.frame({ type: "control_request", request_id: "x", request: { subtype: "can_use_tool" } })).toBe(false);
    expect(elicit.frame({ type: "assistant" })).toBe(false);
    expect(elicit.answer("tool-123", "allow")).toBe(false);
  });
});
