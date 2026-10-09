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
});
