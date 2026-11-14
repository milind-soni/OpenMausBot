import { describe, expect, it } from "vitest";

import { scopeHint, withScopeHint } from "./connector-scope-hint.ts";

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const refused = {
  jsonrpc: "2.0",
  id: 7,
  result: {
    content: [{ type: "text", text: "403 Forbidden: Request had insufficient authentication scopes. ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
    isError: true,
  },
};

describe("connector scope hint (MOCA-273)", () => {
  it("adds the fix to a refused Gmail filter call and keeps Google's error", () => {
    const out = JSON.parse(decode(withScopeHint(encode(refused), "application/json", ["GMAIL_CREATE_FILTER"])));
    expect(out.result.content[0]).toEqual(refused.result.content[0]);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[1].text).toContain("https://www.googleapis.com/auth/gmail.settings.basic");
    expect(out.result.content[1].text).toContain("Do not retry");
  });

  it("names the sharing scope for forwarding and send-as tools", () => {
    expect(scopeHint(["GMAIL_ADD_FORWARDING_ADDRESS"])).toContain("gmail.settings.sharing");
    expect(scopeHint(["GMAIL_CREATE_SEND_AS_ALIAS"])).toContain("gmail.settings.sharing");
  });

  it("explains a refusal from another app without naming a scope it cannot know", () => {
    const hint = scopeHint(["GOOGLECALENDAR_CREATE_EVENT"]);
    expect(hint).toContain("Google refused this");
    expect(hint).toContain("the permission this action needs");
  });

  it("annotates a streamed (SSE) response", () => {
    const body = `event: message\ndata: ${JSON.stringify(refused)}\n\n`;
    const out = decode(withScopeHint(encode(body), "text/event-stream", ["GMAIL_CREATE_FILTER"]));
    const frame = JSON.parse(out.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(frame.result.content).toHaveLength(2);
    expect(out.startsWith("event: message\n")).toBe(true);
  });

  it("returns every other response byte for byte", () => {
    const ok = encode({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "relay-ok" }] } });
    expect(withScopeHint(ok, "application/json", ["GMAIL_SEND_EMAIL"])).toBe(ok);
    const unreadable = encode("ACCESS_TOKEN_SCOPE_INSUFFICIENT but not JSON");
    expect(withScopeHint(unreadable, "application/json", ["GMAIL_CREATE_FILTER"])).toBe(unreadable);
  });

  it("does not name an app it does not know", () => {
    const hint = scopeHint([]);
    expect(hint).toContain("The app refused this");
    expect(hint).not.toContain("This app");
  });
});

describe("connector scope hint only for failed calls (#2467)", () => {
  const pitfall = '[GMAIL_FETCH_EMAILS] HTTP 403 "insufficient authentication scopes" persists until the connection is re-authorized with required Gmail scopes.';
  const toolResult = (id: number, payload: unknown, isError = false) => ({
    jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError },
  });
  const search = toolResult(3, {
    successful: true,
    error: null,
    data: {
      results: [{ tool_slug: "GMAIL_FETCH_EMAILS", known_pitfalls: [pitfall] }],
      toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true, status_message: "Connection is active and ready to use" }],
    },
  });

  it("leaves a successful COMPOSIO_SEARCH_TOOLS answer that quotes the 403 as a pitfall untouched", () => {
    const json = encode(search);
    expect(withScopeHint(json, "application/json", [])).toBe(json);
    const sse = encode(`event: message\ndata: ${JSON.stringify(search)}\n\n`);
    expect(withScopeHint(sse, "text/event-stream", [])).toBe(sse);
  });

  it("leaves a batch untouched when every tool in it succeeded", () => {
    const batch = encode(toolResult(4, {
      successful: true,
      data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { note: pitfall }, error: null } }] },
    }));
    expect(withScopeHint(batch, "application/json", ["GMAIL_FETCH_EMAILS"])).toBe(batch);
  });

  it("annotates a refusal nested in a batch and names the tool that failed", () => {
    const batch = toolResult(5, {
      successful: false,
      data: {
        results: [
          { tool_slug: "GMAIL_CREATE_FILTER", response: { successful: true, data: { id: "f1" }, error: null } },
          { tool_slug: "GMAIL_ADD_FORWARDING_ADDRESS", response: { successful: false, data: {}, error: "403 Forbidden: ACCESS_TOKEN_SCOPE_INSUFFICIENT" } },
        ],
      },
    });
    const out = JSON.parse(decode(withScopeHint(encode(batch), "application/json", ["GMAIL_CREATE_FILTER", "GMAIL_ADD_FORWARDING_ADDRESS"])));
    expect(out.result.content).toHaveLength(2);
    expect(out.result.content[1].text).toContain("gmail.settings.sharing");
    expect(out.result.content[1].text).not.toContain("gmail.settings.basic");
  });

  it("annotates a failed call that reports its 403 in an error field", () => {
    const failed = toolResult(6, { successful: false, data: { message: "Request had insufficient authentication scopes." }, error: "Forbidden" });
    const out = JSON.parse(decode(withScopeHint(encode(failed), "application/json", ["GMAIL_CREATE_FILTER"])));
    expect(out.result.content[1].text).toContain("gmail.settings.basic");
  });
});
