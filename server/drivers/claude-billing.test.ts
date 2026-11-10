import { describe, expect, it } from "vitest";

import { claudeBilling } from "./claude-billing.ts";

describe("claudeBilling", () => {
  it("counts a Claude Code login as the plan", () => {
    expect(claudeBilling({}, { email: "person@example.test" })).toEqual({ billing: "subscription" });
  });

  it("meters an API key in the environment", () => {
    expect(claudeBilling({ ANTHROPIC_API_KEY: "sk-ant-fixture" }, undefined)).toEqual({ account: { method: "api-key" }, billing: "metered" });
  });

  it("meters Amazon Bedrock, which bills the AWS account per token, even with a login on the computer", () => {
    expect(claudeBilling({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "bedrock-prod" }, { email: "person@example.test" })).toEqual({ billing: "metered" });
    expect(claudeBilling({ CLAUDE_CODE_USE_BEDROCK: "0" }, undefined)).toEqual({ billing: "subscription" });
  });
});
