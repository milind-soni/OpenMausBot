import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isSensitiveInput } from "../third_party/playwright-injected/secretInput.ts";
import { sanitizeSnapshotUrl } from "../third_party/playwright-injected/publicUrl.ts";
import { yamlEscapeValueIfNeeded } from "../third_party/playwright-injected/isomorphic/yaml.ts";

describe("browser snapshot sensitive inputs", () => {
  it("redacts credentials, verification codes, and payment/identity fields", () => {
    const sensitive = [
      ["password", ["ordinary-name"]],
      ["text", ["api_key"]],
      ["text", [null, "one-time-code"]],
      ["tel", ["verificationCode"]],
      ["text", ["recovery_code"]],
      ["text", ["cardNumber"]],
      ["text", ["cc-number"]],
      ["text", ["billing_cvv"]],
      ["text", ["bankRoutingNumber"]],
      ["text", ["social_security_number"]],
      ["textarea", ["recovery_codes"]],
      ["text", ["account_pin"]],
      ["text", ["securityCode"]],
      ["text", ["API key", "credential"]],
      ["textarea", ["Recovery codes", "notes"]],
      ["text", ["secret key"]],
      ["text", ["private_key"]],
      ["text", ["signingKey"]],
      ["text", ["webhook secret"]],
      ["text", ["AWS_SECRET_ACCESS_KEY"]],
      ["text", ["refresh token"]],
      ["text", ["bearer_token"]],
      ["textarea", ["seed phrase"]],
      ["textarea", ["mnemonic"]],
      ["textarea", ["recovery phrase"]],
      ["text", ["security answer"]],
    ];
    for (const [type, hints] of sensitive) expect(isSensitiveInput(type, hints)).toBe(true);
  });

  it("keeps ordinary editable values useful to the agent", () => {
    expect(isSensitiveInput("search", ["query", "Search products"])).toBe(false);
    expect(isSensitiveInput("text", ["display_name", "Name"])).toBe(false);
    expect(isSensitiveInput("email", ["contact_email", "Email"])).toBe(false);
    expect(isSensitiveInput("text", ["shipping_address"])).toBe(false);
    expect(isSensitiveInput("text", ["spinning_wheel"])).toBe(false);
  });

  it("ships the rebuilt page bundle with textarea redaction and URL scrubbing", () => {
    const bundle = readFileSync(fileURLToPath(new URL("./resources/browser-snapshot.js", import.meta.url)), "utf8");
    expect(bundle).toContain("HTMLTextAreaElement");
    expect(bundle).toContain("[redacted]");
    expect(bundle).toContain("protected field");
    expect(bundle).toContain("protected field label");
    expect(bundle).toContain("recovery");
    expect(bundle).toContain("webhook");
    expect(bundle).toContain("search=");
    expect(bundle).toContain("hash=");
  });
});

describe("browser snapshot links", () => {
  it("keeps the useful path while dropping URL credentials, queries, and fragments", () => {
    expect(sanitizeSnapshotUrl("https://user:pass@example.com/oauth/callback?code=secret#token"))
      .toBe("https://example.com/oauth/callback");
    expect(sanitizeSnapshotUrl("/download/report?signature=secret#page", "https://example.com/base"))
      .toBe("https://example.com/download/report");
    expect(sanitizeSnapshotUrl("mailto:user@example.com?body=secret"))
      .toBe("mailto://");
  });
});

describe("browser snapshot YAML", () => {
  it("quotes the YAML null sentinel instead of changing page text into null", () => {
    expect(yamlEscapeValueIfNeeded("~")).toBe('"~"');
  });
});
