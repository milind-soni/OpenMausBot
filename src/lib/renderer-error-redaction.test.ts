import { describe, expect, it } from "vitest";

import { redactRendererErrorText } from "./renderer-error-redaction";

describe("renderer error redaction", () => {
  it("removes email, user identity, and local file paths before transport", () => {
    const value = [
      "failed for person@example.test user_id=customer-42",
      "at render (/Users/example/private-project/src/main.tsx:10:4)",
      "at C:\\Users\\Example\\private-project\\main.js:20:2",
    ].join("\n");
    const redacted = redactRendererErrorText(value)!;
    expect(redacted).not.toContain("person@example.test");
    expect(redacted).not.toContain("customer-42");
    expect(redacted).not.toContain("private-project");
    expect(redacted).toContain("redacted-email");
    expect(redacted).toContain("redacted-path");
  });

  it("bounds renderer error text", () => {
    expect(redactRendererErrorText("x".repeat(20_000))).toHaveLength(8_000);
  });

  it("redacts camel-case identifiers and common credential query parameters", () => {
    const value = [
      "userId=customer-camel accountId=account-camel",
      "https://example.test/fail?token=token-value&api_key=underscore-value&apiKey=camel-value",
    ].join("\n");
    const redacted = redactRendererErrorText(value)!;

    for (const secret of [
      "customer-camel",
      "account-camel",
      "token-value",
      "underscore-value",
      "camel-value",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/redacted-id/g)).toHaveLength(2);
    expect(redacted.match(/redacted-value/g)).toHaveLength(3);
  });
});
