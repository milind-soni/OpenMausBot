import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { alwaysAllowScope, answeredStepPrompts, askedOftenHint, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";

type Card = NonNullable<Message["card"]>;
let next = 0;
function prompt(extra: Partial<Card> = {}): Message {
  next += 1;
  return {
    id: `card-${next}`, at: next, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], tool: "Bash", requestId: `r-${next}`, ...extra },
  };
}
const answered = (extra: Partial<Card> = {}) => prompt({ answered: "allow", ...extra });

describe("asked-often hint on the approval card", () => {
  it("counts only answered step prompts", () => {
    const messages = [
      answered(), answered({ answered: "deny" }), answered({ tool: "Edit" }),
      prompt(),
      answered({ requestType: "question" }),
      answered({ autoApplied: true }),
      answered({ outboundRequest: { tool: "send", app: "gmail" } }),
      answered({ yourComputer: { app: "Finder" } }),
      { id: "text", at: 99, role: "bot", kind: "text", text: "hi" } as Message,
    ];
    expect(answeredStepPrompts(messages)).toBe(3);
  });

  it("suggests Approve for me after three answered prompts at Ask, where the engine has its own reviewer", () => {
    expect(askedOftenHint("ask", "claudeAgent", 2, "Scout", "key")).toBeUndefined();
    const hint = askedOftenHint("ask", "claudeAgent", 3, "Scout", "key");
    expect(hint).toContain("Approve for me");
    expect(hint).toContain("Scout");
    expect(hint).toContain("Always allow");
    expect(askedOftenHint("edits", "claudeAgent", 5, "Scout", "key")).toContain("Approve for me");
  });

  it("offers only Always allow where the engine has no reviewer", () => {
    const hint = askedOftenHint("ask", "openaiChat", 4, "Scout", "key");
    expect(hint).toContain("Always allow");
    expect(hint).not.toContain("Approve for me");
  });

  it("names Always allow only when the card offers it", () => {
    const hint = askedOftenHint("ask", "codex", 3, "Scout", undefined);
    expect(hint).toContain("Approve for me");
    expect(hint).not.toContain("Always allow");
    expect(askedOftenHint("ask", "openaiChat", 3, "Scout", undefined)).toBeUndefined();
  });

  it("says a session-only Always allow lasts until the session ends", () => {
    const alone = askedOftenHint("ask", "openaiChat", 3, "Scout", "session");
    expect(alone).toContain("Always allow this session");
    expect(alone).toContain("until the session ends");
    expect(alone).not.toContain("won't ask about it again.");
    expect(askedOftenHint("ask", "codex", 3, "Scout", "session")).toContain("until the session ends");
  });

  it("tells a Qwen bot's owner that Approve for me blocks risky steps instead of asking", () => {
    const hint = askedOftenHint("ask", "qwenAgent", 3, "Scout", undefined);
    expect(hint).toContain("Approve for me");
    expect(hint).toContain("blocked");
    expect(hint).not.toContain("asked only about risky steps");
    expect(askedOftenHint("ask", "claudeAgent", 3, "Scout", undefined)).toContain("asked only about risky steps");
  });

  it("says nothing at Approve for me, Full access or Custom", () => {
    for (const mode of ["auto", "full", "custom"] as const) expect(askedOftenHint(mode, "claudeAgent", 10, "Scout", "key")).toBeUndefined();
  });

  it("shows the hint line on the card only when given", () => {
    const [pending] = pendingApprovals([prompt()]);
    const plain = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
    expect(plain).not.toContain("data-asked-often");
    const hinted = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0, hint: askedOftenHint("ask", "codex", 3, "Scout", "key") }));
    expect(hinted).toContain("data-asked-often");
    expect(hinted).toContain("Approve for me");
  });

  it("matches the hint to the Always allow the card's buttons offer, command grants included", () => {
    const commandAllowlist = { command: "ls -la", cwd: "/work", providerInstanceId: "claude" };
    const [command] = pendingApprovals([prompt()]).map((pending) => ({ ...pending, commandAllowlist, allowSession: true }));
    expect(alwaysAllowScope(command, true, true)).toBe("command");
    expect(alwaysAllowScope(command, false, true)).toBe("session");
    expect(alwaysAllowScope(command, null, true)).toBe("session");
    expect(alwaysAllowScope({ ...command, allowKey: "Bash" }, true, true)).toBe("key");
    expect(alwaysAllowScope({ ...command, allowKey: "Bash" }, true, false)).toBeUndefined();
    expect(alwaysAllowScope({ ...command, allowSession: false }, false, true)).toBeUndefined();
    const hint = askedOftenHint("ask", "openaiChat", 3, "Scout", "command");
    expect(hint).toContain("Always allow this command");
    expect(hint).not.toContain("until the session ends");
    expect(askedOftenHint("ask", "codex", 3, "Scout", "command")).toContain("Always allow this command");
  });
});
