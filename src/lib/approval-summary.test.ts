import { describe, expect, it } from "vitest";

import {
  composioActionPhrase,
  outboundApp,
  outboundCalls,
  outboundSummary,
  parseOutboundCalls,
  type OutboundCall,
} from "./approval-summary";
import type { OptionCardData } from "@/state/store";

// The subtitle the computer writes for two held Linear comments
// (server/index.ts, outbound hold): heading, then raw arguments.
const linearSubtitle = [
  "Linear · Create linear comment",
  '{"issueId":"2f04bc73","body":"**In flight** — open PR"}… [arguments truncated]',
  "",
  "Linear · Create linear comment",
  '{"issueId":"1c2755f","body":"Adjacent request from Discord"}… [arguments truncated]',
].join("\n");

function outbound(calls: OutboundCall[] | undefined, subtitle = linearSubtitle): OptionCardData {
  return {
    title: "Send on your behalf?",
    subtitle,
    options: ["Allow", "Deny"],
    requestId: "req",
    tool: "LINEAR_CREATE_LINEAR_COMMENT",
    held: "This sends something on your behalf, so it always asks first.",
    heldCode: "approval.held.outbound",
    outboundRequest: { tool: "LINEAR_CREATE_LINEAR_COMMENT", app: "Linear", ...(calls ? { calls } : {}) },
  };
}

describe("outboundSummary", () => {
  it("collapses two calls to one app with a count", () => {
    const call = { app: "Linear", label: "Create linear comment" };
    const card = outbound([call, call]);
    expect(outboundApp(outboundCalls(card))).toBe("Linear");
    expect(outboundSummary(card)).toEqual({ headline: "Send to Linear?", summary: "Create linear comment ×2" });
  });

  it("reads the subtitle headings back when the card has no calls", () => {
    const card = outbound(undefined);
    expect(outboundCalls(card)).toHaveLength(2);
    expect(outboundSummary(card)).toEqual({ headline: "Send to Linear?", summary: "Create linear comment ×2" });
  });

  it("treats an empty calls list like a missing one", () => {
    expect(outboundSummary(outbound([]))?.summary).toBe("Create linear comment ×2");
  });

  it("uses the generic headline for several apps and names each app", () => {
    const card = outbound([
      { app: "Gmail", label: "Send email" },
      { app: "Stripe", label: "Create refund" },
      { app: "Gmail", label: "Send email" },
    ]);
    expect(outboundApp(outboundCalls(card))).toBeNull();
    expect(outboundSummary(card)).toEqual({
      headline: "Send on your behalf?",
      summary: "Gmail · Send email ×2, Stripe · Create refund",
    });
  });

  it("names three distinct actions and counts the rest", () => {
    const calls = [1, 2, 3, 4, 5].map((n) => ({ app: "Linear", label: `Action ${n}` }));
    expect(outboundSummary(outbound(calls))?.summary).toBe("Action 1, Action 2, Action 3, +2 more");
  });

  it("falls back to the generic headline and no summary when the subtitle cannot be read", () => {
    const card = outbound(undefined, "\n\nsomething odd");
    expect(outboundCalls(card)).toEqual([]);
    expect(outboundSummary(card)).toEqual({ headline: "Send on your behalf?", summary: "" });
  });

  it("names a tool with no app by its label", () => {
    const card = outbound(undefined, 'Send a message\n{"to":"x"}');
    expect(outboundCalls(card)).toEqual([{ app: null, label: "Send a message" }]);
    expect(outboundSummary(card)).toEqual({ headline: "Send on your behalf?", summary: "Send a message" });
  });

  it("is undefined for a card that is not an outbound hold", () => {
    const permission: OptionCardData = { title: "Approval needed", subtitle: "git push", options: ["Allow", "Deny"], tool: "Bash" };
    expect(outboundSummary(permission)).toBeUndefined();
    expect(outboundCalls(permission)).toEqual([]);
  });
});

describe("parseOutboundCalls", () => {
  it("reads every block's heading and ignores the arguments", () => {
    expect(parseOutboundCalls('Gmail · Send email\n{"to":"a · b"}\n\nStripe · Create refund')).toEqual([
      { app: "Gmail", label: "Send email" },
      { app: "Stripe", label: "Create refund" },
    ]);
  });

  it("gives up on the whole subtitle when one block has no heading", () => {
    expect(parseOutboundCalls("Linear · Create issue\n{}\n\n\n\nGmail · Send email")).toEqual([]);
  });
});

describe("composioActionPhrase", () => {
  it("turns a Composio slug into a verb phrase", () => {
    expect(composioActionPhrase("LINEAR_CREATE_LINEAR_COMMENT")).toBe("create linear comment");
    expect(composioActionPhrase("GMAIL_SEND_EMAIL")).toBe("send email");
  });

  it("leaves other tool names alone", () => {
    expect(composioActionPhrase("Bash")).toBeUndefined();
    expect(composioActionPhrase("computer_batch")).toBeUndefined();
    expect(composioActionPhrase("LINEAR")).toBeUndefined();
  });
});

describe("outboundSummary for code run on the app's side", () => {
  it("says code runs on Composio instead of naming a send", () => {
    const card = { subtitle: 'Composio · Proxy execute\n{"code_to_execute":"print(1)"}',
      outboundRequest: { tool: "COMPOSIO_PROXY_EXECUTE", app: "Composio", calls: [{ app: "Composio", label: "Proxy execute" }] } };
    expect(outboundSummary(card)).toEqual({ headline: "Run code on Composio?", summary: "", opaque: true });
  });
});
