import { describe, expect, it } from "vitest";

import { acpNativeLogMessage } from "./tool-log.ts";

describe("acpNativeLogMessage", () => {
  it("redacts authenticate _meta in the log copy without changing the wire message", () => {
    const wire = {
      jsonrpc: "2.0", id: 7, method: "authenticate",
      params: { methodId: "devin-browser", _meta: { api_key: "fixture-secret" } },
    };

    const logged = acpNativeLogMessage(wire, false) as { params: { methodId: string; _meta: string } };

    expect(logged.params).toEqual({ methodId: "devin-browser", _meta: "[redacted]" });
    expect(JSON.stringify(logged)).not.toContain("fixture-secret");
    expect(wire.params._meta).toEqual({ api_key: "fixture-secret" });
  });
});
