import { describe, expect, it } from "vitest";
import { claudeElicitations } from "./claude-elicitation.ts";

function harness(delivered = true) {
  const written: any[] = [];
  const events: any[] = [];
  const elicit = claudeElicitations(async (frame) => { written.push(frame); return delivered; }, (event) => events.push(event));
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
  it("turns a plain confirmation into an approval card and accepts it", async () => {
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
    await expect(elicit.answer("elicitation:e1", "allow")).resolves.toBe("sent");
    expect(written).toEqual([sent("e1", { action: "accept", content: {} })]);
    expect(events.at(-1)).toEqual(done("e1", "allow", "user"));
    await expect(elicit.answer("elicitation:e1", "allow")).resolves.toBe(false);
  });

  it("declines when the person declines", async () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e2"));
    await expect(elicit.answer("elicitation:e2", "deny")).resolves.toBe("sent");
    expect(written).toEqual([sent("e2", { action: "decline" })]);
    expect(events.at(-1)).toEqual(done("e2", "deny", "user"));
  });

  it("withdraws the card when the CLI cancels the question", async () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e3"));
    expect(elicit.frame({ type: "control_cancel_request", request_id: "e3" })).toBe(true);
    expect(events.at(-1)).toEqual(done("e3", "deny", "timeout"));
    await expect(elicit.answer("elicitation:e3", "allow")).resolves.toBe(false);
    expect(written).toEqual([]);
    expect(elicit.frame({ type: "control_cancel_request", request_id: "other" })).toBe(false);
  });

  it("declines a form with fields at once and says why", async () => {
    const { elicit, written, events } = harness();
    expect(elicit.frame(ask("e4", { requested_schema: { type: "object", properties: { token: { type: "string" } } } }))).toBe(true);
    expect(written).toEqual([sent("e4", { action: "decline" })]);
    expect(events).toEqual([{ type: "runtime.notice", message: expect.stringContaining("github asked you to fill in a field") }]);
  });

  it("declines a form whose required fields are not listed as properties", async () => {
    const { elicit, written, events } = harness();
    expect(elicit.frame(ask("e4b", { requested_schema: { type: "object", properties: {}, required: ["token"] } }))).toBe(true);
    expect(written).toEqual([sent("e4b", { action: "decline" })]);
    expect(events).toEqual([{ type: "runtime.notice", message: expect.stringContaining("github asked you to fill in a field") }]);
  });

  it("declines a link request and passes on only a web link", async () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e5", { mode: "url", url: "https://example.com/auth" }));
    elicit.frame(ask("e6", { mode: "url", url: "javascript:alert(1)" }));
    elicit.frame(ask("e6b", { mode: "url", url: "http://example.com/auth" }));
    expect(written).toEqual([sent("e5", { action: "decline" }), sent("e6", { action: "decline" }), sent("e6b", { action: "decline" })]);
    expect(events[0].message).toContain(": https://example.com/auth.");
    expect(events[1].message).not.toContain("javascript:");
    expect(events[2].message).not.toContain("http://");
  });

  it("withdraws every open card when the session closes", async () => {
    const { elicit, events } = harness();
    elicit.frame(ask("a"));
    elicit.frame(ask("b"));
    elicit.close();
    expect(events.slice(-2)).toEqual([done("a", "deny", "system"), done("b", "deny", "system")]);
    await expect(elicit.answer("elicitation:a", "allow")).resolves.toBe(false);
  });

  it("withdraws the card instead of showing it approved when the answer can't reach the CLI", async () => {
    const { elicit, written, events } = harness(false);
    elicit.frame(ask("e7"));
    await expect(elicit.answer("elicitation:e7", "allow")).resolves.toBe("failed");
    expect(written).toEqual([sent("e7", { action: "accept", content: {} })]);
    expect(events.at(-1)).toEqual(done("e7", "deny", "system"));
    await expect(elicit.answer("elicitation:e7", "allow")).resolves.toBe(false);
  });

  it("withdraws a card whose answer was still on its way when the session closed", async () => {
    let deliver!: (ok: boolean) => void;
    const events: any[] = [];
    const elicit = claudeElicitations(() => new Promise<boolean>((resolve) => { deliver = resolve; }), (event) => events.push(event));
    elicit.frame(ask("e8"));
    const answered = elicit.answer("elicitation:e8", "allow");
    elicit.close();
    expect(events.filter((e) => e.type === "request.resolved")).toEqual([done("e8", "deny", "system")]);
    deliver(true);
    await expect(answered).resolves.toBe("failed");
    expect(events.filter((e) => e.type === "request.resolved")).toEqual([done("e8", "deny", "system")]);
  });

  it("withdraws a card the CLI cancels while its answer is still on its way", async () => {
    let deliver!: (ok: boolean) => void;
    const events: any[] = [];
    const elicit = claudeElicitations(() => new Promise<boolean>((resolve) => { deliver = resolve; }), (event) => events.push(event));
    elicit.frame(ask("e9"));
    const answered = elicit.answer("elicitation:e9", "allow");
    expect(elicit.frame({ type: "control_cancel_request", request_id: "e9" })).toBe(true);
    expect(events.filter((e) => e.type === "request.resolved")).toEqual([done("e9", "deny", "timeout")]);
    elicit.close();
    deliver(true);
    await expect(answered).resolves.toBe("failed");
    expect(events.filter((e) => e.type === "request.resolved")).toEqual([done("e9", "deny", "timeout")]);
  });

  it("leaves other frames and cards alone", async () => {
    const { elicit } = harness();
    expect(elicit.frame({ type: "control_request", request_id: "x", request: { subtype: "can_use_tool" } })).toBe(false);
    expect(elicit.frame({ type: "assistant" })).toBe(false);
    await expect(elicit.answer("tool-123", "allow")).resolves.toBe(false);
  });
});
