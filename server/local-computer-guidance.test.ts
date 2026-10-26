import { describe, expect, it } from "vitest";

import { localComputerResultLine, OWN_PROFILE_UNAVAILABLE } from "./local-computer-guidance.ts";

// cua-driver 0.28.2's answer to browser_prepare {strategy:{kind:"existing_profile"}} from a standard-mode daemon, verbatim.
const EXISTING_PROFILE_REFUSAL = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: {
    content: [{ text: "refused (browser_consent_required): existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest", type: "text" }],
    structuredContent: {
      refusal: {
        code: "browser_consent_required",
        detail: { authorization_host: null, authorization_required: true, permission_mode: "standard" },
        message: "existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest",
      },
      status: "refused",
    },
  },
});

describe("localComputerResultLine", () => {
  it("tells the bot what to do instead when the driver refuses to attach to the person's signed-in profile", () => {
    const original = JSON.parse(EXISTING_PROFILE_REFUSAL);
    const rewritten = JSON.parse(localComputerResultLine(EXISTING_PROFILE_REFUSAL));

    expect(rewritten.result.content).toEqual([...original.result.content, { type: "text", text: OWN_PROFILE_UNAVAILABLE }]);
    expect(rewritten.result.structuredContent).toEqual(original.result.structuredContent);
    expect(rewritten.id).toBe(2);
  });

  it("names only routes the bot has, and rules out the one it cannot take", () => {
    expect(OWN_PROFILE_UNAVAILABLE).toMatch(/do not retry strategy existing_profile/u);
    for (const tool of ["launch_app", "get_window_state", "click", "type_text", "request_sign_in"]) {
      expect(OWN_PROFILE_UNAVAILABLE).toContain(tool);
    }
  });

  it("passes every other frame through byte for byte", () => {
    const otherRefusal = EXISTING_PROFILE_REFUSAL
      .replaceAll("browser_consent_required", "browser_requires_setup")
      .replaceAll("existing-profile attachment", "this browser");
    for (const line of [
      otherRefusal,
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "prepared" }], structuredContent: { status: "ok" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_prepare", arguments: { strategy: { kind: "existing_profile" } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, error: { code: -32603, message: "browser_consent_required" } }),
      "not json browser_consent_required",
    ]) {
      expect(localComputerResultLine(line)).toBe(line);
    }
  });
});
