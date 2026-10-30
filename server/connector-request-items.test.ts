import { describe, expect, it } from "vitest";

import { connectorRequestItems } from "./connector-request-items.ts";

describe("connector card requests", () => {
  it("keeps a valid auth config id with its toolkit and refuses a malformed one", () => {
    expect(connectorRequestItems([
      "Gmail",
      { slug: "xero", authConfigId: "ac_xero1234" },
      { toolkit: "BUFFER", alias: " work " },
      { slug: "not a slug" },
    ])).toEqual([{ slug: "gmail" }, { slug: "xero", authConfigId: "ac_xero1234" }, { slug: "buffer", alias: "work" }]);
    for (const authConfigId of ["xero-app", 42, ""]) {
      expect(() => connectorRequestItems([{ slug: "xero", authConfigId }]))
        .toThrow(expect.objectContaining({ status: 400, message: "authConfigId must be a Composio auth config id (ac_…)" }));
    }
  });
});
