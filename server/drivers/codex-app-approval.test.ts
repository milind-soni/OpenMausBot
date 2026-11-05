import { describe, expect, it } from "vitest";

import { mcpAppApprovalForm } from "./codex-app-approval.ts";

const request = (message?: unknown) => ({
  mode: "form", message, _meta: { app_name: "Safari" },
  requestedSchema: { properties: { approval: { enum: ["once"] } }, required: ["approval"] },
});

describe("MCP app-access summary", () => {
  it.each([undefined, "", "\n", "x".repeat(161)])("codes only its own fallback for %j", (message) => {
    expect(mcpAppApprovalForm(request(message))).toEqual({
      tool: "Safari", summary: "App access requested", summaryCode: "chat.notice.appAccessRequested",
      allowResult: { action: "accept", content: { approval: "once" } },
    });
  });

  it("leaves a provider's message and inferred app name as data", () => {
    const form = request("Allow ChatGPT to use Safari?");
    expect(mcpAppApprovalForm({ ...form, _meta: {} })).toEqual({
      tool: "Safari", summary: "Allow ChatGPT to use Safari?",
      allowResult: { action: "accept", content: { approval: "once" } },
    });
  });
});
