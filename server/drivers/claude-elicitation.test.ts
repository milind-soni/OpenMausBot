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
    expect(events).toEqual([{ type: "runtime.notice", message: 'github asked you to fill in a field ("Allow access to your repos?"). OpenMausBot can\'t show that form yet, so the request was declined.',
      text: { key: "chat.notice.elicitationFormDeclinedOneMessage", params: { server: "github", message: "Allow access to your repos?" } } }]);
  });

  it("declines a form whose required fields are not listed as properties", async () => {
    const { elicit, written, events } = harness();
    expect(elicit.frame(ask("e4b", { requested_schema: { type: "object", properties: {}, required: ["token"] } }))).toBe(true);
    expect(written).toEqual([sent("e4b", { action: "decline" })]);
    expect(events).toEqual([{ type: "runtime.notice", message: 'github asked you to fill in a field ("Allow access to your repos?"). OpenMausBot can\'t show that form yet, so the request was declined.',
      text: { key: "chat.notice.elicitationFormDeclinedOneMessage", params: { server: "github", message: "Allow access to your repos?" } } }]);
  });

  it("declines a link request and passes on only a web link", async () => {
    const { elicit, written, events } = harness();
    elicit.frame(ask("e5", { mode: "url", url: "https://example.com/auth" }));
    elicit.frame(ask("e6", { mode: "url", url: "javascript:alert(1)" }));
    elicit.frame(ask("e6b", { mode: "url", url: "http://example.com/auth" }));
    expect(written).toEqual([sent("e5", { action: "decline" }), sent("e6", { action: "decline" }), sent("e6b", { action: "decline" })]);
    expect(events[0].message).toBe("github asked you to open a link to continue: https://example.com/auth. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.");
    expect(events[0].text).toEqual({ key: "chat.notice.elicitationUrlDeclinedWithUrl", params: { server: "github", url: "https://example.com/auth" } });
    expect(events[1].message).not.toContain("javascript:");
    expect(events[2].message).not.toContain("http://");
    expect(events[1].text).toEqual({ key: "chat.notice.elicitationUrlDeclined", params: { server: "github" } });
    expect(events[2].text).toEqual(events[1].text);
  });

  it.each([
    ["github", "", "chat.notice.elicitationContinue", { server: "github" }, "github asks to continue"],
    ["", "", "chat.notice.elicitationContinueGeneric", undefined, "An MCP server asks to continue"],
    ["", "External words", "chat.notice.elicitationMessageGeneric", { message: "External words" }, "An MCP server: External words"],
  ])("codes the app-owned confirmation words for %s / %s", (server, message, key, params, summary) => {
    const { elicit, events } = harness();
    elicit.frame(ask("confirmation", { mcp_server_name: server, message }));
    expect(events[0]).toMatchObject({ summary, summaryCode: key });
    expect(events[0].summaryParams).toEqual(params);
  });

  it.each([false, true])("keeps the generic server out of raw params in URL notices (%s)", (withUrl) => {
    const { elicit, events } = harness();
    elicit.frame(ask("url", { mcp_server_name: "", mode: "url", url: withUrl ? "https://example.com" : "http://example.com" }));
    expect(events[0].message).toBe(`An MCP server asked you to open a link to continue${withUrl ? ": https://example.com" : ""}. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.`);
    expect(events[0].text).toEqual({ key: `chat.notice.elicitationUrlDeclinedGeneric${withUrl ? "WithUrl" : ""}`, params: withUrl ? { url: "https://example.com" } : {} });
  });

  it.each([1, 2])("codes named and generic forms with %i fields and preserves external words", (fields) => {
    for (const server of ["", "External name"]) {
      for (const message of ["", "External message"]) {
        const { elicit, events } = harness();
        elicit.frame(ask("form", { display_name: server, mcp_server_name: "", message,
          requested_schema: { properties: Object.fromEntries(Array.from({ length: fields }, (_, i) => [`field${i}`, { type: "string" }])) } }));
        expect(events[0].message).toBe(`${server || "An MCP server"} asked you to fill in ${fields === 1 ? "a field" : `${fields} fields`}${message ? ` ("${message}")` : ""}. OpenMausBot can't show that form yet, so the request was declined.`);
        expect(events[0].text).toEqual({ key: `chat.notice.elicitationFormDeclined${server ? "" : "Generic"}${fields === 1 ? "One" : "Many"}${message ? "Message" : ""}`, params: {
          ...(server ? { server } : {}), ...(fields === 1 ? {} : { fields }), ...(message ? { message } : {}),
        } });
      }
    }
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
