import { describe, expect, it } from "vitest";

import { parseEnv } from "./vault";

describe("a pasted .env file", () => {
  it("keeps each NAME=value line, dropping export, quotes, comments and empty values; a later line wins", () => {
    expect(parseEnv([
      "# Stripe",
      "export STRIPE_SECRET_KEY=sk_test_fake-1   # test mode",
      "NOTION_TOKEN=\"fake \\\"two\\\"\\nline\"",
      "SINGLE='a # b'",
      "EMPTY=",
      "not a line",
      "  SPACED = fake-3  ",
      "STRIPE_SECRET_KEY=sk_test_fake-4",
    ].join("\r\n"))).toEqual([
      { name: "STRIPE_SECRET_KEY", value: "sk_test_fake-4" },
      { name: "NOTION_TOKEN", value: "fake \"two\"\nline" },
      { name: "SINGLE", value: "a # b" },
      { name: "SPACED", value: "fake-3" },
    ]);
  });
});
